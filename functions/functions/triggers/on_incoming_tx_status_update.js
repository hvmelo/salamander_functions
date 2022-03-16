import admin from "firebase-admin";
import * as functions from "firebase-functions";

const db = admin.firestore();
const addressesCollection = db.collection("addresses");

export const onIncomingTxStatusUpdate = functions.firestore
    .document("addresses/{address}/incoming_txs/{tx_hash}")
    .onWrite(async (change, context) => {
      const address = context.params.address;

      await db.runTransaction(async (t) => {
        const addressRef = addressesCollection.doc(address);
        const incomingTxColRef = addressRef.collection("incoming_txs");

        const collectionSnap = await incomingTxColRef.get();
        const addressBalance = collectionSnap.docs.reduce((accum, doc) => {
          if (doc.data()["status"] == "CONFIRMED") {
            accum["confirmed_balance"] += doc.data()["amount"];
          } else {
            accum["unconfirmed_balance"] += doc.data()["amount"];
          }
          return accum;
        }, {"confirmed_balance": 0, "unconfirmed_balance": 0});

        t.update(addressRef,
            {
              address_balance_confirmed:
                  addressBalance["confirmed_balance"],
              address_balance_unconfirmed:
                  addressBalance["unconfirmed_balance"],
            });
      });
    });

