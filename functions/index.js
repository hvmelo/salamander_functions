'use strict';

const functions = require('firebase-functions');
 
const admin = require('firebase-admin');
admin.initializeApp();

exports.createWallet = functions.auth.user().onCreate((user) => {
    walletDoc = {
        'current_balance': 0,
        'last_updated': new Date(),
        'owner': {
            email: user.email,
            uid: user.uid,
        }
    };
    // Push the new message into Firestore using the Firebase Admin SDK.
    admin.firestore().collection('wallets').add(walletDoc).then(writeResult => {
        console.log('Wallet Created result:', writeResult);
        return;
    }).catch(err => {
        console.log(err);
        return;
    });

 });
 
 // [START addMessage]
 // Take the text parameter passed to this HTTP endpoint and insert it into 
 // Firestore under the path /messages/:documentId/original
 // [START addMessageTrigger]
 exports.addMessage = functions.https.onRequest(async (req, res) => {
 // [END addMessageTrigger]
   // Grab the text parameter.
   const original = req.query.text;
   // [START adminSdkAdd]
   // Push the new message into Firestore using the Firebase Admin SDK.
   const writeResult = await admin.firestore().collection('messages').add({original: original});
   // Send back a message that we've successfully written the message
   res.json({result: `Message with ID: ${writeResult.id} added.`});
   // [END adminSdkAdd]
 });
 // [END addMessage]
 
 // [START makeUppercase]
 // Listens for new messages added to /messages/:documentId/original and creates an
 // uppercase version of the message to /messages/:documentId/uppercase
 // [START makeUppercaseTrigger]
 exports.makeUppercase = functions.firestore.document('/messages/{documentId}')
     .onCreate((snap, context) => {
 // [END makeUppercaseTrigger]
       // [START makeUppercaseBody]
       // Grab the current value of what was written to Firestore.
       const original = snap.data().original;
 
       // Access the parameter `{documentId}` with `context.params`
       functions.logger.log('Uppercasing', context.params.documentId, original);
       
       const uppercase = original.toUpperCase();
       
       // You must return a Promise when performing asynchronous tasks inside a Functions such as
       // writing to Firestore.
       // Setting an 'uppercase' field in Firestore document returns a Promise.
       return snap.ref.set({uppercase}, {merge: true});
       // [END makeUppercaseBody]
     });
 // [END makeUppercase]
 // [END all]


