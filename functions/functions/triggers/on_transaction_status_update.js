import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";

const db = admin.firestore();
const walletsCollection = db.collection("wallets");

export const onTransactionStatusUpdate = functions.firestore
    .document("wallets/{walletId}/transactions/{tx_id}")
    .onWrite(async (change, context) => {
      const walletId = context.params.walletId;

      console.log("Detected a status update for a transaction relevant " +
      `to wallet '${walletId}'. Updating wallet balances...`);

      await db.runTransaction(async (t) => {
        const walletRef = walletsCollection.doc(walletId);
        const walletSnap = await walletRef.get();
        if (!walletSnap.exists) {
          console.log(`No wallets found with id '${walletId}'`);
          return;
        }
        const transactionsColRef = walletRef.collection("transactions");

        const collectionSnap = await transactionsColRef.get();

        if (collectionSnap.empty) {
          console.log(`No transactions found related to wallet '${walletId}'`);
          return;
        }
        const txBalance = collectionSnap.docs.reduce((accum, doc) => {
          const direction = doc.data()["direction"];
          const status = doc.data()["status"];
          const amount = direction == "INCOMING" ? doc.data()["amount"] :
                doc.data()["amount"] + doc.data()["fee"];

          const accumName =
          direction == "INCOMING" ?
            (status == "CONFIRMED" ? "incoming_conf" : "incoming_unconf") :
            (status == "CONFIRMED" ? "outgoing_conf" : "outgoing_unconf");

          accum[accumName] += amount;
          return accum;
        }, {
          "incoming_conf": 0, "incoming_unconf": 0,
          "outgoing_conf": 0, "outgoing_unconf": 0,
        });

        const totalSettled =
        txBalance["incoming_conf"] -
        txBalance["outgoing_conf"] -
        txBalance["outgoing_unconf"];


        t.set(walletRef,
            {
              balance: {
                total_settled: totalSettled,
                incoming: {
                  confirmed: txBalance["incoming_conf"],
                  unconfirmed: txBalance["incoming_unconf"],
                },
                outgoing: {
                  confirmed: txBalance["outgoing_conf"],
                  unconfirmed: txBalance["outgoing_unconf"],
                },
              },
              last_updated: FieldValue.serverTimestamp(),
            },
        );

        console.log(`Updated balance for wallet '${walletId}'. ` +
        `Incoming confirmed : ${txBalance["incoming_conf"]}. ` +
        `Incoming unconfirmed: ${txBalance["incoming_unconf"]}. ` +
        `Outgoing confirmed : ${txBalance["outgoing_conf"]}. ` +
        `Outgoing unconfirmed: ${txBalance["outgoing_unconf"]}. ` +
        `Currently settled: ${totalSettled}.`,
        );
      });
    });
