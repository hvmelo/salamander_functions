import admin from "firebase-admin";
import * as functions from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";

const db = admin.firestore();
const walletsCollection = db.collection("wallets");

export const onOutgoingTxStatusUpdate = functions.firestore
    .document("wallets/{walletId}/outgoing_txs/{tx_id}")
    .onWrite(async (change, context) => {
      const walletId = context.params.walletId;

      await db.runTransaction(async (t) => {
        const walletRef = walletsCollection.doc(walletId);
        const outgoingTxColRef = walletRef.collection("outgoing_txs");

        const collectionSnap = await outgoingTxColRef.get();
        const outgoingBalance = collectionSnap.docs.reduce((accum, doc) => {
          if (doc.data()["status"] == "CONFIRMED") {
            accum["confirmed_balance"] += doc.data()["amount"];
          } else {
            accum["unconfirmed_balance"] += doc.data()["amount"];
          }
          return accum;
        }, {"confirmed_balance": 0, "unconfirmed_balance": 0});

        t.set(walletRef,
            {
              balance: {
                outgoing: {
                  confirmed: outgoingBalance["confirmed_balance"],
                  unconfirmed: outgoingBalance["unconfirmed_balance"],
                },
              },
              last_updated: FieldValue.serverTimestamp(),
            }, {merge: true},
        );
      });
    });
