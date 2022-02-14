import * as functions from "firebase-functions";
import admin from "firebase-admin";
import {Timestamp, FieldValue} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v1/https";
import * as lnd from "./lnd.js";


// Initialize Firestore
admin.initializeApp();
const db = admin.firestore();
const walletsCollection = db.collection("wallets");
const usersCollection = db.collection("users");
const addressesCollection = db.collection("addresses");
const configCollection = db.collection("config");

export const createWallet = functions.
    https.onCall(async (data, context) => {
    // verify Firebase Auth ID token
      if (!context.auth) {
        throw new HttpsError("unauthenticated", "Authetication is required!");
      }

      const userId = context.auth.uid;
      const email = context.auth.token.email || null;
      const name = context.auth.token.name || null;


      // Checks if the user is already in the database
      const userRef = usersCollection.doc(userId);
      const userCheck = await userRef.get();

      if (userCheck.exists) {
        throw new HttpsError("already-exists", "This user is already in the " +
        "database. Use addWallet to add another wallet to this user");
      }

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      let address;
      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;
        const NESTED_PUBKEY_HASH = 1;

        const result = await Lightning.newAddress({type: NESTED_PUBKEY_HASH});
        if (result != null) {
          address = result.address;
        } else {
          throw new HttpsError("aborted",
              "Error when trying to to retrieve a new address.");
        }
      } else {
        throw new HttpsError("aborted",
            "Error when trying to to retrieve a new address.");
      }

      // Creates the wallet document
      const walletDoc = {
        "current_address": address,
        "current_balance": 0,
        "last_updated": new Date(),
        "owner_id": userId,
        "addresses": [address],
      };

      const walletDocRef = walletsCollection.doc();

      // Creates the address document
      const addressDoc = {
        "wallet_id": walletDocRef.id,
      };

      // Creates the user document
      const userDoc = {
        "email": email,
        "name": name,
        "current_wallet_id": walletDocRef.id,
        "associated_wallet_ids": [walletDocRef.id],
      };

      // Creates the batch (commit everything together or rollback otherwise)
      const batch = db.batch();
      batch.set(walletDocRef, walletDoc);
      batch.set(usersCollection.doc(userId), userDoc);
      batch.set(addressesCollection.doc(address), addressDoc);

      try {
        await batch.commit();
        return {wallet_id: walletDocRef.id};
      } catch (error) {
        console.log(error);
        throw new HttpsError("aborted",
            "An error occurred when commiting changes to the database");
      }
    });

// Saves a message to the Firebase Realtime Database but sanitizes the
// text by removing swearwords.
export const addMessage = functions.https.
    onCall((data, context) => {
    // Message text passed from the client.
      const text = data.text;

      // Checking attribute.
      if (!(typeof text === "string") || text.length === 0) {
      // Throwing an HttpsError so that the client gets the error details.
        throw new HttpsError("invalid-argument",
            "The function must be called with one arguments \"text\" " +
        "containing the message text to add.");
      }
      // Checking that the user is authenticated.
      if (!context.auth) {
      // Throwing an HttpsError so that the client gets the error details.
        throw new HttpsError("failed-precondition",
            "The function must be called while authenticated.");
      }

      // Authentication / user information is automatically added to the
      // request.
      const uid = context.auth.uid;
      const name = context.auth.token.name || null;
      const picture = context.auth.token.picture || null;
      const email = context.auth.token.email || null;

      // Saving the new message to Firestore.
      return db.collection("messages").add({
        text: text.toUpperCase(),
        author: {uid, name, picture, email},
      }).then(() => {
        console.log("New Message written");
        // Returning the sanitized message to the client.
        return {text: text.toUpperCase()};
      })
          .catch((error) => {
            // Re-throwing the error as an HttpsError so that the client
            // gets the error details.
            throw new HttpsError("unknown", error.message, error);
          });
    });


export const walletBalance = functions.
    https.onCall(async (data, context) => {
    // verify Firebase Auth ID token
      if (!context.auth) {
        return {message: "Authentication Required!", code: 401};
      }

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;
        const balance = await Lightning.walletBalance();
        return {wallet_balance: balance};
      } else {
        throw new HttpsError("aborted",
            "Error when trying to activate lightning");
      }
    });

export const getTransactions = functions.
    https.onCall(async (data, context) => {
    // verify Firebase Auth ID token
      if (!context.auth) {
        return {message: "Authentication Required!", code: 401};
      }

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;
        const transactions = await Lightning.getTransactions({start_height: 0});
        return {transactions};
      } else {
        throw new HttpsError("aborted",
            "Error when trying to activate lightning");
      }
    });

/* SYNC TRANSACTIONS METHODS **************************** */

export const syncTransactions = functions.
    https.onCall(async (data, context) => {
      const addresses = await getAddresses();

      // Connect to the lnd server and activate lightining (if needed)
      await lnd.activateLightning();

      if (lnd.grpc.state == "active") {
        const {Lightning} = lnd.grpc.services;

        // Retrieve the last block synced from firestore
        const blockHeight = await currentBlockHeight();

        // Retrieve transactions starting from block_height
        const result = await Lightning.
            getTransactions({start_height: blockHeight});

        /* Filter transactions list so that it contains only the ones with
           addresses related to wallets */
        const relevantTxs = result.transactions?.reverse().
            reduce((relevantList, tx) => {
              if (tx.amount > 0) {
                const address = tx.dest_addresses.
                    find((element) => addresses[element]);
                if (address) {
                  tx.address = address;
                  relevantList.push(tx);
                }
              }
              return relevantList;
            }, []);

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
          const lndSyncDoc = {"block_height": updatedBlockHeight,
            "timestamp": FieldValue.serverTimestamp()};
          await configCollection.doc("lnd_sync").set(lndSyncDoc);
        }

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
  const addressList = addressesSnap.docs.reduce((accum, doc) => {
    accum[doc.id] = doc.data();
    return accum;
  }, {});
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
    } else {
      confirmedTx.push(tx);
      lastConfirmedBlock = transaction.block_height;
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


