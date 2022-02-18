import admin from "firebase-admin";
import * as functions from "firebase-functions";

const db = admin.firestore();
const addressesCollection = db.collection("addresses");

export const updateAddressBalance = functions.firestore
    .document("addresses/{address}/incoming_txs/{tx_hash}")
    .onWrite(async (change, context) => {
      const address = context.params.address;

      await db.runTransaction(async (t) => {
        const addressRef = addressesCollection.doc(address);
        const incomingTxColRef = addressRef.collection("incoming_txs");

        const txSnap = await incomingTxColRef.get();
        const addressBalance = txSnap.docs.reduce((accum, doc) => {
          if (doc.data()["status"] == "CONFIRMED") {
            accum["confirmed_balance"] += doc.data()["amount"];
          } else {
            accum["pending_balance"] += doc.data()["amount"];
          }
          return accum;
        }, {"confirmed_balance": 0, "pending_balance": 0});

        t.update(addressRef,
            {
              confirmed_balance: addressBalance["confirmed_balance"],
              pending_balance: addressBalance["pending_balance"],
            });
      });
    });
