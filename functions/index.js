"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {HttpsError} = require("firebase-functions/v1/https");
admin.initializeApp();

const walletsCollection = admin.firestore().collection("wallets");
const usersCollection = admin.firestore().collection("users");

// exports.createWallet = functions.auth.user().onCreate(async (user) => {
//   const walletDoc = {
//     "current_balance": 0,
//     "last_updated": new Date(),
//     "owner_id": user.uid,
//   };
//   // Push the new message into Firestore using the Firebase Admin SDK.
//   const walletDocRef = await admin.firestore().collection("wallets")
//       .add(walletDoc);

//   const userDoc = {
//     "current_wallet_id": walletDocRef.id,
//   };

//   return admin.firestore().collection("users").doc(user.uid).set(userDoc);
// });

exports.createWallet = functions.region("southamerica-east1").
    https.onCall((data, context) => {
      const userId = context.auth.uid;
      const walletDoc = {
        "current_balance": 0,
        "last_updated": new Date(),
        "owner_id": userId,
      };

      const walletDocRef = walletsCollection.doc();

      const userDoc = {
        "current_wallet_id": walletDocRef.id,
      };

      const batch = admin.firestore().batch();
      batch.set(walletDocRef, walletDoc);
      batch.set(usersCollection.doc(userId), userDoc);

      return batch.commit()
          .then((writeResult) => {
            console.log(writeResult);
            return {wallet_id: walletDocRef.id};
          })
          .catch((err) => {
            console.log(err);
            throw new HttpsError("write-wallet-error",
                "Error while writing to the database");
          });
    });

exports.addMessage = functions.https.onRequest(async (req, res) => {
  // Grab the text parameter.
  const original = req.query.text;
  // Push the new message into Firestore using the Firebase Admin SDK.
  const writeResult = await admin.firestore().collection("messages")
      .add({original: original});
  // Send back a message that we've successfully written the message
  res.json({result: `Message with ID: ${writeResult.id} added.`});
});

exports.makeUppercase = functions.firestore.document("/messages/{documentId}")
    .onCreate((snap, context) => {
      const original = snap.data().original;

      // Access the parameter `{documentId}` with `context.params`
      functions.logger.log("Uppercasing", context.params.documentId, original);

      const uppercase = original.toUpperCase();

      // You must return a Promise when performing asynchronous tasks inside
      // a Functions such as writing to Firestore.
      // Setting an 'uppercase' field in Firestore document returns a Promise.
      return snap.ref.set({uppercase}, {merge: true});
    });


