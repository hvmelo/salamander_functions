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
                const address = tx.dest_addresses.find(
                    (element) => addresses[element]);
                if (address) {
                  tx.walletId = addresses[address];
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

        let earliestBlockWithUnconfirmedTx = null;
        let latestBlockWithConfirmedTx = null;

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

            const batchResult = await runBatch(relevantTxs, start, end);

            earliestBlockWithUnconfirmedTx =
            earliestBlockWithUnconfirmedTx ??
            batchResult.earliestBlockWithUnconfirmedTx;

            latestBlockWithConfirmedTx =
            batchResult.latestBlockWithConfirmedTx ??
            latestBlockWithConfirmedTx;
          }

          const newBlockHeight = earliestBlockWithUnconfirmedTx ??
          (latestBlockWithConfirmedTx ?
            latestBlockWithConfirmedTx + 1 : blockHeight);

          const lndSyncDoc = {
            "block_height": newBlockHeight,
            "timestamp": FieldValue.serverTimestamp(),
          };
          await configCollection.doc("lnd_sync").set(lndSyncDoc);
          console.log(`Next sync block height: ${newBlockHeight}`);
        } else {
          console.log("As there are no transactions to sync, " +
          "will just update last sync timestamp. " +
          `Next sync block height: ${blockHeight}`);
          const lndSyncDoc = {
            "block_height": blockHeight,
            "timestamp": FieldValue.serverTimestamp(),
          };
          await configCollection.doc("lnd_sync").set(lndSyncDoc);
        }
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
 * @param {Array} transactions the full list of transactions
 * @param {int} start the index of the first transaction of this batch
 * @param {int} end the index of the last transaction of this batch
 * @return {Map} the latest block where confirmed transations were found and
 *                the earliest block where unconfirmed transactions were found.
 */
async function runBatch(transactions, start, end) {
  console.log(`Processing batch from index ${start} to ${end}.`);

  const batch = db.batch();

  let earliestBlockWithUnconfirmedTx = null;
  let latestBlockWithConfirmedTx = null;

  for (let i = start; i < end; i++) {
    const transaction = transactions[i];

    let txStatus;
    if (transaction.amount > 0) {
      // This is an incoming transaction
      txStatus = await processIncomingTransaction(batch, transaction);
    } else if (transaction.amount < 0) {
      // This is an outgoing transaction (onchain payment)
      txStatus = await processOutgoingTransaction(batch, transaction);
    } else {
      console.log("Transaction with amount equal 0 was " +
        `found: ${transaction.tx_hash}`);
    }

    if (txStatus == "CONFIRMED") {
      latestBlockWithConfirmedTx = transaction["block_height"];
    } else if (txStatus == "UNCONFIRMED") {
      earliestBlockWithUnconfirmedTx =
        earliestBlockWithUnconfirmedTx ??
        transaction["block_height"];
    }
  }

  // Finally commit all the changes to the database
  await batch.commit();

  console.log("The batch was commited.");

  // Returns the updated block height and the earliest block where unconfirmed
  // transactions were found (it may be used in the next batch run)
  return {earliestBlockWithUnconfirmedTx, latestBlockWithConfirmedTx};
}

/**
 * Process an incoming transaction
 * @param {*} batch the current batch being processed
 * @param {*} transaction the current transaction being processed
 * @return {Map} the latest block where confirmed transations were found and
 *                the earliest block where unconfirmed transactions were found.
 */
async function processIncomingTransaction(batch, transaction) {
  const walletId = transaction.walletId;

  const tx = {
    "address": transaction.address,
    "tx_hash": transaction.tx_hash,
    "block_height": transaction.block_height,
    "timestamp": Timestamp.fromMillis(transaction.time_stamp * 1000),
    "amount": transaction.amount,
    "status": transaction.num_confirmations < 6 ? "UNCONFIRMED" : "CONFIRMED",
  };

  // The transaction doc id will be the transaction hash, as it is unique.
  // We write it as an element of the incoming subcollection inside
  // the wallet document

  const incomingTxColRef = walletsCollection.doc(walletId).
      collection("incoming_txs");
  const txRef = incomingTxColRef.doc(transaction.tx_hash);


  // Writes the transaction to the firebase database.
  // Will update fields if is exists.
  batch.set(txRef, tx);

  if (transaction.num_confirmations < 6) {
    console.log(`Saved UNCONFIRMED incoming tx: ${transaction.tx_hash}. ` +
      `(${transaction.num_confirmations} confirmations).`);
    return "UNCONFIRMED";
  }

  console.log(`INCOMING transaction to address ${transaction.address} ` +
    `is now CONFIRMED. Tx hash: ${transaction.tx_hash}. ` +
    `(${transaction.num_confirmations} confirmations).`);

  return "CONFIRMED";
}


/**
 * Process an outgoing transaction
 * @param {*} batch the current batch being processed
 * @param {*} transaction the current transaction being processed
 * @return {Map} the latest block where confirmed transations were found and
 *                the earliest block where unconfirmed transactions were found.
 */
async function processOutgoingTransaction(batch, transaction) {
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
    console.log(`No payment found with id '${paymentId}' from wallet ` +
      `${walletId}. Creating a new one (will save destination address ` +
      `as UNKNOWN. Tx hash: ${transaction.tx_hash}.`);
    tx = {
      "to_address": "UNKNOWN",
      "created": "UNKNOWN",
      "amount": Math.abs(transaction.amount) - transaction.total_fees,
      "txid": transaction.tx_hash,
    };
  }

  tx["timestamp"] = Timestamp.fromMillis(transaction.time_stamp * 1000);
  tx["fee"] = transaction.total_fees;
  if (transaction.num_confirmations < 6) {
    tx["status"] = "UNCONFIRMED";
    if (transaction.block_height > 0) {
      tx["block_height"] = transaction.block_height;
    } else {
      tx["status"] = "MEMPOOL";
    }
    // Writes the transaction to the firebase database.
    // Will update fields if is exists.
    batch.set(txRef, tx);
    console.log(`Found ${tx.status} outgoing tx from wallet '${walletId}'. ` +
      `Payment id: ${paymentId}. Tx hash: ${transaction.tx_hash}. ` +
      `Num confirmations: ${tx.status == "MEMPOOL" ? 0 :
        transaction.num_confirmations}.`);

    return tx.status;
  }

  tx["status"] = "CONFIRMED";
  tx["block_height"] = transaction.block_height;

  // Writes the transaction to the firebase database.
  // Will update fields if is exists.
  batch.set(txRef, tx);
  console.log(`OUTGOING transaction from wallet '${walletId}' is now ` +
    `CONFIRMED. Payment id: ${paymentId}. ` +
    `${transaction.num_confirmations} confirmations. ` +
    `Tx hash: ${transaction.tx_hash}.`);

  return "CONFIRMED";
}

/**
 * Get the list of incoming addresses relevant to the database
 * @return {Array} the list of incoming addresses
 */
async function getAddresses() {
  const addressesSnap = await addressesCollection.get();
  const addressList = addressesSnap.docs.reduce((accum, doc) => {
    accum[doc.id] = doc.data()["wallet_id"];
    return accum;
  }, {});
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
