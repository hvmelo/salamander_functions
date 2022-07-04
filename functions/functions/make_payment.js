import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {HttpsError} from "firebase-functions/v1/https";
import {Timestamp, FieldValue} from "firebase-admin/firestore";
import {validate} from "bitcoin-address-validation";
import * as lnd from "../init/lnd_init.js";


const MIN_AMOUNT_IN_SATS = 2500;
const MIN_FEE_IN_SATS = 1;
const TRANSFER_MARGIN_IN_SATS = 1000;
const AVERAGE_TRANSACTION_SIZE = 250;
const MEMPOOL_WAITING_TIME = 1000;

const db = admin.firestore();
const usersCollection = db.collection("users");
const walletsCollection = db.collection("wallets");
const configCollection = db.collection("config");


export const makePayment = functions.
    https.onCall(async (data, context) => {
      if (!context.auth) {
        throw new HttpsError("permission-denied", "Authetication is required!");
      }

      const userId = context.auth.uid;

      // Retrieve the current user data
      const userRef = usersCollection.doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        const msg = `User not found with id ${userId}`;
        console.log(msg);
        throw new HttpsError("not-found", msg);
      }

      const address = data.address || null;
      const amount = data.amount || null;
      const fee = data.fee || null;

      if (!address || !amount || !fee) {
        throw new HttpsError("invalid-argument", "Required parameters missing");
      }

      // The current wallet is the wallet that will be used for spending
      const currentWalletId = userDoc.data()["active_wallet_id"];

      console.log(`Payment request from wallet ${currentWalletId} ` +
      `to address ${address}. Amount: ${amount} sats. ` +
      `Fee: ${fee} sats per vbyte`);

      if (!validate(address)) {
        const msg = "The bitcoin address is in invalid format.";
        console.log(msg);
        throw new HttpsError("invalid-argument", msg);
      }

      if (amount < MIN_AMOUNT_IN_SATS) {
        const msg = `The minimum amount is ${MIN_AMOUNT_IN_SATS} sats.`;
        console.log(msg);
        throw new HttpsError("failed-precondition", msg);
      }

      if (fee < MIN_FEE_IN_SATS) {
        const msg = `The minimum fee is ${MIN_FEE_IN_SATS}.`;
        console.log(msg);
        throw new HttpsError("failed-precondition", msg);
      }

      await db.runTransaction(async (t) => {
        const walletRef = walletsCollection.doc(currentWalletId);
        const walletDoc = await walletRef.get();

        const totalTransferWithMargin = amount +
        (fee * AVERAGE_TRANSACTION_SIZE) + TRANSFER_MARGIN_IN_SATS;
        const availableBalance = walletDoc.data()["balance"]["total_settled"];
        if (!availableBalance || availableBalance < totalTransferWithMargin) {
          const msg = "Not enough funds to complete " +
          `the transfer. Needed: ${totalTransferWithMargin}. ` +
          `Available: ${availableBalance}`;
          console.log(msg);
          throw new HttpsError("failed-precondition", msg);
        }

        // Connect to the lnd server and activate lightining (if needed)
        await lnd.activateLightning();

        if (lnd.grpc.state == "active") {
          const {Lightning} = lnd.grpc.services;

          // Creates the lnd service request
          const request = {
            addr: address,
            amount: amount,
            sat_per_vbyte: fee,
            label: `payment:${currentWalletId}:${address}`,
          };

          try {
            const result = await Lightning.sendCoins(request);
            const txid = result.txid;
            console.log("Payment successfully broadcasted with " +
            `transaction hash: ${txid}`);

            // Wait some time so that the mempool can be updated
            await new Promise((r) => setTimeout(r, MEMPOOL_WAITING_TIME));

            const paymentEntry = {
              direction: "OUTGOING",
              tx_hash: txid,
              status: "NEW",
              amount: amount,
              address: address,
              created: FieldValue.serverTimestamp(),
            };

            // Now we will try to get the transaction in the mempool so that we
            // know actual fees
            try {
              const lndSyncSnap = await configCollection.doc("lnd_sync").get();
              const currentBlockHeight = lndSyncSnap.exists ?
              lndSyncSnap.data()["block_height"] : 0;
              const result = await Lightning.getTransactions(
                  {start_height: currentBlockHeight},
              );
              const foundTx = result.transactions.find(
                  (tx) => tx.tx_hash == txid,
              );
              if (foundTx) {
                paymentEntry["fee"] = foundTx.total_fees;
                paymentEntry["timestamp"] =
                Timestamp.fromMillis(foundTx.time_stamp * 1000);
                paymentEntry["status"] = "MEMPOOL";
                console.log("Transaction found in mempool. The actual fee " +
                `is ${foundTx.total_fees}.`);
              } else {
                console.log("Mempool transaction not found when calling " +
                "getTransactions. Couldn't fetch the actual fee." +
                `${txid}.`);
              }
            } catch (error) {
              console.log("Mempool transaction not found when calling " +
              "getTransactions. Couldn't fetch the actual fee for tx " +
              `${txid}.`);
            }

            // Writes the payment entry to Firestore

            try {
            // Creates the payment transaction in Firestore
              const paymentCollectionRef =
              walletsCollection.doc(currentWalletId)
                  .collection("transactions");
              const paymentDocRef = paymentCollectionRef.doc(txid);
              await paymentDocRef.set(paymentEntry);
              console.log("Payment successfully written to the database. " +
              `Tx hash: ${txid}`);
            } catch (error) {
              const msg = "An error occurred while writing the payment entry " +
              `to the database. Tx hash: ${txid}. Message: ${error.message}.`;
              console.log(msg);
              throw new HttpsError("unknown", msg);
            }
          } catch (error) {
            const msg = "An error occurred while broadcasting " +
            `the payment. Message: ${error.message}`;
            console.log(msg);
            throw new HttpsError("unknown", msg);
          }
        } else {
          const msg = "The Lightning server is unavailable.";
          console.log(msg);
          throw new HttpsError("unavailable", msg);
        }
      });
    });
