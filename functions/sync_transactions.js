import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {Timestamp, FieldValue} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v1/https";
import * as lnd from "./lnd.js";

const db = admin.firestore();
const addressesCollection = db.collection("addresses");
const configCollection = db.collection("config");

export const syncTransactions = functions.
    https.onCall(async (data, context) => {
      const addresses = await getAddresses();

      if (addresses.length == 0) {
        console.log("The addresses collection is empty. Aborting.");
      } else {
        console.log(`The number of relevant addresses is ${addresses.length}`);
      }


      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;

        // Retrieve the last block synced from firestore
        const blockHeight = await currentBlockHeight();

        console.log(
            `Getting transactions starting from block height: ${blockHeight}.`,
        );

        // Retrieve transactions starting from block_height
        const result = await Lightning.
            getTransactions({start_height: blockHeight});

        /* Filter transactions list so that it contains only the ones with
           addresses related to wallets */
        const relevantTxs = result.transactions?.reverse().
            reduce((relevantList, tx) => {
              if (tx.amount > 0) {
                const address = tx.dest_addresses.
                    find((element) => addresses.includes(element));
                if (address) {
                  tx.address = address;
                  relevantList.push(tx);
                }
              }
              return relevantList;
            }, []);

        console.log(
            `The number of relevant transactions is ${relevantTxs.length}.`,
        );

        // Sets the batch size (system max is 500)
        const batchSize = 300;

        const confirmedTx = [];
        const unconfirmedTx = [];
        let firstUnconfirmedBlock = -1;
        let updatedBlockHeight = blockHeight;

        // Find out the number of batch runs
        const remainder = relevantTxs.length % batchSize;
        const numberOfRuns = Math.floor(relevantTxs.length / batchSize) +
            (remainder > 0 ? 1 : 0);

        if (numberOfRuns > 0) {
        // Starts iterating over each run
          for (let run = 0; run < numberOfRuns; run++) {
            const start = run * batchSize;
            const end = start + ((run == numberOfRuns - 1 && remainder > 0) ?
               remainder : batchSize);

            const batchResult =
              await runBatch(relevantTxs, start, end, firstUnconfirmedBlock);

            confirmedTx.push(...batchResult.confirmedTx);
            unconfirmedTx.push(...batchResult.unconfirmedTx);
            firstUnconfirmedBlock = batchResult.firstUnconfirmedBlock;
            updatedBlockHeight = batchResult.updatedBlockHeight;
          }
        } else {
          /* As there are no transactions to sync, will just update
             last sync timestamp */
          console.log("As there are no transactions to sync, " +
                      "will just update last sync timestamp.");
          const lndSyncDoc = {"block_height": updatedBlockHeight,
            "timestamp": FieldValue.serverTimestamp()};
          await configCollection.doc("lnd_sync").set(lndSyncDoc);
        }

        console.log("Finished with " +
                `${confirmedTx.length} confirmed, ` +
                `${unconfirmedTx.length} unconfirmed, ` +
                `${updatedBlockHeight} block height.`);

        return {confirmedTx, unconfirmedTx, updatedBlockHeight};
      } else {
        throw new HttpsError("aborted",
            "Error when trying to activate lightning");
      }
    });

/**
 * Get the list of incoming addresses relevant to the database
 * @return {Array} the list of incoming addresses
 */
async function getAddresses() {
  const addressesSnap = await addressesCollection.get();
  const addressList = addressesSnap.docs.map((doc) => doc.id);
  return addressList;
}

/**
 * Get the block height from which the sync process must start
 * @return {int} the block height
 */
async function currentBlockHeight() {
  const lndSyncSnap = await configCollection.doc("lnd_sync").get();
  return lndSyncSnap.exists ? lndSyncSnap.data()["block_height"] : 0;
}

/**
 * Runs a full syncing batch. It writes new transactions to their
 * respective subcollection incoming_tx in the addresses colletion.
 * Then it updates the next sync block height
 * @param {Array} transactions the full list of transactions
 * @param {int} start the index of the first transaction of this batch
 * @param {int} end the index of the last transaction of this batch
 * @param {int} firstUnconfirmedBlock the first unconfirmed block,
 *              from previous runs.
 * @return {Map} the confirmed and unconfirmed transactions written
 *               to the database
 */
async function runBatch(transactions, start, end, firstUnconfirmedBlock) {
  console.log("First block with unconfirmed transactions: " +
     `${firstUnconfirmedBlock ? "None" : firstUnconfirmedBlock}`);
  let lastConfirmedBlock = -1;

  const batch = db.batch();

  const confirmedTx = [];
  const unconfirmedTx = [];

  for (let i = start; i < end; i++) {
    const transaction = transactions[i];
    const tx = {
      "address": transaction.address,
      "action": "RECEIVE",
      "tx_hash": transaction.tx_hash,
      "block_height": transaction.block_height,
      "timestamp": Timestamp.fromMillis(transaction.time_stamp * 1000),
      "amount": transaction.amount,
      "status": transaction.num_confirmations < 6 ?
        "UNCONFIRMED" : "CONFIRMED",
    };

    /* The transaction doc id will be the transaction hash, as it is unique.
        We write it as an element of a subcollection inside the address
        document. */
    const incomingTxColRef = addressesCollection.doc(transaction.address).
        collection("incoming_txs");
    const txRef = incomingTxColRef.doc(transaction.tx_hash);

    /* Writes the transaction to the firebase database.
       Will update fields if is exists.*/
    batch.set(txRef, tx);

    /* Check if the transaction is confirmed. If not, it should be written to
       unconfirmed transactions collection */
    if (transaction.num_confirmations < 6) {
      unconfirmedTx.push(tx);
      firstUnconfirmedBlock = firstUnconfirmedBlock > 0 ?
          firstUnconfirmedBlock : transaction.block_height;
      console.log(`Set UNCONFIRMED tx: ${transaction.tx_hash} ` +
                  `for address ${transaction.address}`);
    } else {
      confirmedTx.push(tx);
      lastConfirmedBlock = transaction.block_height;
      console.log(`Set CONFIRMED tx: ${transaction.tx_hash} ` +
                  `for address ${transaction.address}`);
    }
  }

  /* If we have unconfirmed transactions, we should start the next sync from
     the first block with them. Otherwise, we should start from the block
     subsequent to the last confirmed one. */
  const updatedBlockHeight = firstUnconfirmedBlock > 0 ?
      firstUnconfirmedBlock : lastConfirmedBlock + 1;
  const lndSyncDoc = {"block_height": updatedBlockHeight,
    "timestamp": FieldValue.serverTimestamp()};
  const lndSyncRef = configCollection.doc("lnd_sync");
  batch.set(lndSyncRef, lndSyncDoc);


  // TODO: Update addresses balances

  // Finally commit all the changes to the database
  await batch.commit();

  // Returns the confirmed and unconfirmed transactions and
  // the  first block where there are unconfirmed transactions
  // (it may be used in the next batch run)
  return {confirmedTx, unconfirmedTx,
    updatedBlockHeight, firstUnconfirmedBlock};
}
