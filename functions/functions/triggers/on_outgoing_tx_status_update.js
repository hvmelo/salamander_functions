import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";

const db = admin.firestore();
const walletsCollection = db.collection("wallets");

export const onOutgoingTxStatusUpdate = functions.firestore
    .document("wallets/{walletId}/outgoing_txs/{tx_id}")
    .onWrite(async (change, context) => {
      const walletId = context.params.walletId;

      console.log("Detected an status update for an outgoing tx created " +
      `by wallet '${walletId}. Updating wallet balances...`);

      await db.runTransaction(async (t) => {
        const walletRef = walletsCollection.doc(walletId);
        const walletSnap = await walletRef.get();
        if (!walletSnap.exists) {
          console.log(`No wallets found with id '${walletId}'`);
          return;
        }
        const outgoingTxColRef = walletRef.collection("outgoing_txs");

        const collectionSnap = await outgoingTxColRef.get();

        if (collectionSnap.empty) {
          console.log(`No outgoing txs found for wallet '${walletId}'`);
          return;
        }
        const outgoingBalance = collectionSnap.docs.reduce((accum, doc) => {
          if (doc.data()["status"] == "CONFIRMED") {
            accum["confirmed_balance"] += doc.data()["amount"];
          } else {
            accum["unconfirmed_balance"] += doc.data()["amount"];
          }
          return accum;
        }, {"confirmed_balance": 0, "unconfirmed_balance": 0});

        const walletData = walletSnap.data();
        const totalConfirmed = (walletData.balance?.incoming?.confirmed ?? 0) +
        outgoingBalance["confirmed_balance"];

        t.set(walletRef,
            {
              balance: {
                total_confirmed: totalConfirmed,
                outgoing: {
                  confirmed: outgoingBalance["confirmed_balance"],
                  unconfirmed: outgoingBalance["unconfirmed_balance"],
                },
              },
              last_updated: FieldValue.serverTimestamp(),
            }, {merge: true},
        );

        console.log(`Updated outgoing balance for wallet '${walletId}'. ` +
        `Confirmed: ${outgoingBalance["confirmed_balance"]}. ` +
        `Unconfirmed: ${outgoingBalance["unconfirmed_balance"]}. ` +
        `New total (incoming + outgoing) confirmed: ${totalConfirmed}.`,
        );
      });
    });
