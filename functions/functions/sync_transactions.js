import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {Timestamp, FieldValue} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v1/https";
import * as lnd from "../init/lnd_init.js";

const db = admin.firestore();
const addressesCollection = db.collection("addresses");
const configCollection = db.collection("config");
const walletsCollection = db.collection("wallets");


/**
 * Syncs the incoming transaction collection in Firestore
 * with the ones coming from the lnd node.
 */
export const syncTransactions = functions.
    https.onCall(async (data, context) => {
      console.log("Starting syncTransactions.");

      const addresses = await getAddresses();
      const wallets = await getWallets();

      if (addresses.length == 0 && wallets.length == 0) {
        console.log("Both addresses and wallets collections " +
                "are empty. Aborting.");
        return;
      }

      console.log(`The number of relevant addresses is ${addresses.length}`);
      console.log(`The number of wallets is ${wallets.length}`);

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;

        // Retrieve the last block synced from firestore
        const blockHeight = await currentBlockHeight();

        console.log("Getting transactions starting " +
        `from block height: ${blockHeight}.`);

        // Retrieve transactions starting from block_height
        const result = await Lightning.
            getTransactions({start_height: blockHeight});

        /* Filter transactions list so that it contains only
         the ones with addresses related to wallets */
        const relevantTxs = result.transactions?.reverse().
            reduce((relevantList, tx) => {
              if (tx.amount > 0) {
                const address = tx.dest_addresses.
                    find((element) => addresses.includes(element));
                if (address) {
                  tx.address = address;
                  relevantList.push(tx);
                }
              } else {
                // We filter here the outgoing transactions (on chain payments)
                if (tx.label.startsWith("payment")) {
                  // The label field carries the wallet that spent the coins
                  relevantList.push(tx);
                }
              }
              return relevantList;
            }, []);

        console.log("The number of relevant transactions " +
        `is ${relevantTxs.length}.`);

        // Sets the batch size (system max is 500)
        const batchSize = 300;

        let earliestBlockWithUnconfirmed = -1;
        let updatedBlockHeight = blockHeight;

        // Find out the number of batch runs
        const remainder = relevantTxs.length % batchSize;
        const numberOfRuns = Math.floor(relevantTxs.length / batchSize) +
        (remainder > 0 ? 1 : 0);

        console.log(`The number of batch runs is ${numberOfRuns}.`);

        if (numberOfRuns > 0) {
        // Starts iterating over each run
          for (let run = 0; run < numberOfRuns; run++) {
            const start = run * batchSize;
            const end = start + ((run == numberOfRuns - 1 && remainder > 0) ?
            remainder : batchSize);

            console.log(`Starting batch run #${run + 1} with ` +
            `transactions indexes from ${start} to ${end}.`);

            const batchResult = await runBatch(relevantTxs, start, end,
                updatedBlockHeight, earliestBlockWithUnconfirmed);

            updatedBlockHeight = batchResult.updatedBlockHeight;
            earliestBlockWithUnconfirmed = batchResult.firstUnconfirmedBlock;
          }
        } else {
          console.log("As there are no transactions to sync, " +
          "will just update last sync timestamp.");
          const lndSyncDoc = {
            "block_height": updatedBlockHeight,
            "timestamp": FieldValue.serverTimestamp(),
          };
          await configCollection.doc("lnd_sync").set(lndSyncDoc);
        }


        console.log("Finished. Updated block height " +
        `for next sync: ${updatedBlockHeight}`);
      } else {
        throw new HttpsError("aborted",
            "Error when trying to activate lightning");
      }
    });


/**
 * Runs a full syncing batch. It does the following tasks:
 * 1. Insert (or update) incoming transactions to their
 *    respective subcollection (incoming_txs) in the addresses colletion.
 * 2. Insert (or update)  outgoing transactions (payments) to their
 *    respective subcolletion (outgoing_txs) in the wallets collection.
 * 3. Updates the block height for the next batch.
 * @param {Array} transactions the full list of transactions
 * @param {int} start the index of the first transaction of this batch
 * @param {int} end the index of the last transaction of this batch
 * @param {int} lastConfirmedBlock the last block where there are
 *              confirmed transaction block,
 * @param {int} earliestBlockWithUnconfirmed the earliest block where
 *              there are unconfirmed transactions.
 * @return {Map} the updated lastConfirmedBlock and
 *               earliestBlockWithUnconfirmed to be used in the next
 *               batch.
 */
async function runBatch(transactions, start, end,
    lastConfirmedBlock, earliestBlockWithUnconfirmed) {
  console.log("Earliest block with unconfirmed transactions: " +
    `${earliestBlockWithUnconfirmed ?
      "None" : earliestBlockWithUnconfirmed}`);

  const batch = db.batch();

  for (let i = start; i < end; i++) {
    const transaction = transactions[i];

    let result;
    if (transaction.amount > 0) {
      // This is an incoming transaction
      result = await processIncomingTransaction(batch, transaction,
          lastConfirmedBlock,
          earliestBlockWithUnconfirmed);
    } else if (transaction.amount < 0) {
      // This is an outgoing transaction (onchain payment)
      result = await processOutgoingTransaction(batch, transaction,
          lastConfirmedBlock,
          earliestBlockWithUnconfirmed);
    } else {
      console.log("Transaction with amount equal 0 was " +
        `found: ${transaction.tx_hash}`);
    }
    if (result) {
      lastConfirmedBlock = result.lastConfirmedBlock;
      earliestBlockWithUnconfirmed = result.earliestBlockWithUnconfirmed;
    }
  }

  /* If we have unconfirmed transactions, we should start the next sync
     from the earliest block with them.
     Otherwise, we should start from the block subsequent
     to the last confirmed one. */
  const updatedBlockHeight = earliestBlockWithUnconfirmed > 0 ?
    earliestBlockWithUnconfirmed : lastConfirmedBlock + 1;
  const lndSyncDoc = {
    "block_height": updatedBlockHeight,
    "timestamp": FieldValue.serverTimestamp(),
  };
  const lndSyncRef = configCollection.doc("lnd_sync");
  batch.set(lndSyncRef, lndSyncDoc);

  console.log(`Saved updated block height: ${updatedBlockHeight}`);

  // Finally commit all the changes to the database
  await batch.commit();

  console.log("The batch was commited.");

  // Returns the updated block height and the earliest block where unconfirmed
  // transactions were found (it may be used in the next batch run)
  return {updatedBlockHeight, earliestBlockWithUnconfirmed};
}

/**
 * Process an incoming transaction
 * @param {*} batch the current batch being processed
 * @param {*} transaction the current transaction being processed
 * @param {*} lastConfirmedBlock the last block where there are
 *                               confirmed transactions
 * @param {*} earliestBlockWithUnconfirmed the earliest block where there
 *                                         are unconfirmed transactions
 * @return {Map} the updated lastConfirmedBlock and
 *               earliestBlockWithUnconfirmed to be used in the next
 *               batch.
 */
async function processIncomingTransaction(batch, transaction,
    lastConfirmedBlock,
    earliestBlockWithUnconfirmed) {
  const tx = {
    "address": transaction.address,
    "tx_hash": transaction.tx_hash,
    "block_height": transaction.block_height,
    "timestamp": Timestamp.fromMillis(transaction.time_stamp * 1000),
    "amount": transaction.amount,
    "status": transaction.num_confirmations < 6 ? "UNCONFIRMED" : "CONFIRMED",
  };

  // The transaction doc id will be the transaction hash, as it is unique.
  // We write it as an element of a subcollection inside the address document
  const incomingTxColRef = addressesCollection.doc(transaction.address).
      collection("incoming_txs");
  const txRef = incomingTxColRef.doc(transaction.tx_hash);

  // Writes the transaction to the firebase database.
  // Will update fields if is exists.
  batch.set(txRef, tx);

  // Check if the transaction is confirmed. If not, it should be written
  // to unconfirmed transactions collection
  if (transaction.num_confirmations < 6) {
    earliestBlockWithUnconfirmed = earliestBlockWithUnconfirmed > 0 ?
      earliestBlockWithUnconfirmed :
      (transaction.block_height > 0 ?
        transaction.block_height : -1);
    console.log(`Saved UNCONFIRMED incoming tx: ${transaction.tx_hash}. ` +
      `(${transaction.num_confirmations} confirmations).`);
  } else {
    lastConfirmedBlock = transaction.block_height;
    console.log("INCOMING transaction is now CONFIRMED. Tx hash: " +
      `${transaction.tx_hash}. (${transaction.num_confirmations} ` +
      "confirmations).");
  }

  return {lastConfirmedBlock, earliestBlockWithUnconfirmed};
}


/**
 * Process an outgoing transaction
 * @param {*} batch the current batch being processed
 * @param {*} transaction the current transaction being processed
 * @param {*} lastConfirmedBlock the last block where there are
 *                               confirmed transactions
 * @param {*} earliestBlockWithUnconfirmed the earliest block where there
 *                                         are unconfirmed transactions
 * @return {Map} the updated lastConfirmedBlock and
 *               earliestBlockWithUnconfirmed to be used in the next
 *               batch.
 */
async function processOutgoingTransaction(batch, transaction,
    lastConfirmedBlock,
    earliestBlockWithUnconfirmed) {
  // Get the transaction in the database
  const labelSplit = transaction.label.split(":");
  const walletId = labelSplit[1];
  const paymentId = labelSplit[2];

  const outgoingTxColRef = walletsCollection.doc(walletId).
      collection("outgoing_txs");
  const txRef = outgoingTxColRef.doc(paymentId);
  const txSnap = await txRef.get();

  let tx;
  if (txSnap.exists) {
    tx = txSnap.data();
  } else {
    console.log(`No payment found with id: ${paymentId} in wallet ` +
      `${walletId}. Creating a new one. ` +
      `Tx hash: ${transaction.tx_hash}.`);
    tx = {
      "to_address": "UNKNOWN",
      "created": "UNKNOWN",
      "amount": Math.abs(transaction.amount) - transaction.total_fees,
      "txid": transaction.tx_hash,
    };
  }
  const newStatus = transaction.num_confirmations < 6 ?
    "UNCONFIRMED" : "CONFIRMED";
  if (tx["status"] == "NEW" || tx["status"] != newStatus) {
    tx["timestamp"] = Timestamp.fromMillis(transaction.time_stamp * 1000);
    tx["fee"] = transaction.total_fees;
    if (transaction.num_confirmations < 6) {
      tx["status"] = "UNCONFIRMED";
      if (transaction.block_height > 0) {
        tx["block_height"] = transaction.block_height;
        earliestBlockWithUnconfirmed = earliestBlockWithUnconfirmed > 0 ?
          earliestBlockWithUnconfirmed : transaction.block_height;
      }
      // Writes the transaction to the firebase database.
      // Will update fields if is exists.
      batch.set(txRef, tx);
      console.log(`Saved UNCONFIRMED outcoming tx id: ${paymentId}`);
    } else {
      tx["status"] = "CONFIRMED";
      tx["block_height"] = transaction.block_height;
      lastConfirmedBlock = transaction.block_height;

      // Writes the transaction to the firebase database.
      // Will update fields if is exists.
      batch.set(txRef, tx);
      console.log("OUTGOING transaction is now CONFIRMED. Payment id: " +
        `${paymentId}. ${transaction.num_confirmations} ` +
        `confirmations. Tx hash: ${transaction.tx_hash}.`);
    }
  } else {
    console.log("Found unconfirmed outcoming tx but with no changes. " +
      `Payment id: ${paymentId}. ${transaction.num_confirmations} ` +
      `confirmations. Tx hash: ${transaction.tx_hash}.`);
  }

  return {lastConfirmedBlock, earliestBlockWithUnconfirmed};
}


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
 * Get the list of all wallet ids from the database
 * @return {Array} the list os all wallet ids
 */
async function getWallets() {
  const walletsSnap = await walletsCollection.get();
  const walletList = walletsSnap.docs.map((doc) => doc.id);
  return walletList;
}

/**
 * Get the block height from which the sync process must start
 * @return {int} the block height
 */
async function currentBlockHeight() {
  const lndSyncSnap = await configCollection.doc("lnd_sync").get();
  return lndSyncSnap.exists ? lndSyncSnap.data()["block_height"] : 0;
}
