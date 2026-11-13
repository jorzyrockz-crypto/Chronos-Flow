'use strict';

const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const webpush = require('web-push');
const { defineSecret, defineString } = require('firebase-functions/params');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');

initializeApp();
const db = getFirestore();
const REGION = 'us-central1';
const VAPID_PUBLIC_KEY = defineString('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = defineString('VAPID_SUBJECT');

const DEFAULT_PREFERENCES = {
  notifications: true
};

function configureWebPush() {
  webpush.setVapidDetails(
    VAPID_SUBJECT.value(),
    VAPID_PUBLIC_KEY.value(),
    VAPID_PRIVATE_KEY.value()
  );
}

function makePayload(title, body, tag, data = {}) {
  return {
    title: String(title || 'Chronos Flow').slice(0, 120),
    body: String(body || 'You have a new Chronos update.').slice(0, 300),
    tag: String(tag || 'chronos-push').slice(0, 120),
    url: './',
    data: { ...data, url: './' }
  };
}

function deliveryId(uid, subscriptionId, dedupeKey) {
  return crypto
    .createHash('sha256')
    .update(`${uid}|${subscriptionId}|${dedupeKey}`)
    .digest('hex');
}

async function claimDelivery(uid, subscriptionId, dedupeKey) {
  const ref = db.collection('pushDeliveries').doc(deliveryId(uid, subscriptionId, dedupeKey));
  const now = Date.now();
  let claimed = false;

  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    if (current?.status === 'sent') return;
    if (current?.status === 'sending' && now - Number(current.startedAt || 0) < 5 * 60 * 1000) return;

    transaction.set(ref, {
      uid,
      subscriptionId,
      status: 'sending',
      startedAt: now,
      dedupeKeyHash: crypto.createHash('sha256').update(String(dedupeKey)).digest('hex')
    }, { merge: true });
    claimed = true;
  });

  return claimed ? ref : null;
}

async function sendToSubscription(uid, subscriptionDoc, payload, dedupeKey) {
  const subscription = subscriptionDoc.data() || {};
  if (subscription.enabled === false || !subscription.endpoint ||
      !subscription.keys?.p256dh || !subscription.keys?.auth) return false;

  const receiptRef = await claimDelivery(uid, subscriptionDoc.id, dedupeKey);
  if (!receiptRef) return false;

  try {
    configureWebPush();
    await webpush.sendNotification({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime || null,
      keys: subscription.keys
    }, JSON.stringify(payload), {
      TTL: 60 * 60,
      urgency: 'normal'
    });
    await receiptRef.set({ status: 'sent', sentAt: Date.now() }, { merge: true });
    return true;
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await subscriptionDoc.ref.delete().catch(() => {});
    }
    await receiptRef.delete().catch(() => {});
    throw error;
  }
}

function isValidSubscriptionData(subscription) {
  return Boolean(
    subscription &&
    subscription.enabled !== false &&
    subscription.endpoint &&
    subscription.keys?.p256dh &&
    subscription.keys?.auth
  );
}

async function getUserPushContext(uid, cache, preloadedSubscriptions = null) {
  if (!cache.has(uid)) {
    cache.set(uid, (async () => {
      const userRef = db.collection('users').doc(uid);
      const preferencesPromise = userRef.collection('settings').doc('preferences').get();
      const subscriptionsPromise = preloadedSubscriptions
        ? Promise.resolve(preloadedSubscriptions)
        : userRef.collection('pushSubscriptions').get().then(snap =>
          snap.docs.filter(doc => isValidSubscriptionData(doc.data()))
        );
      const [preferencesSnapshot, subscriptions] = await Promise.all([
        preferencesPromise,
        subscriptionsPromise
      ]);
      const saved = preferencesSnapshot.exists ? preferencesSnapshot.data() || {} : {};
      const preferences = saved.value || saved.settings || {};
      return {
        preferences: { ...DEFAULT_PREFERENCES, ...preferences },
        subscriptions
      };
    })());
  }
  return cache.get(uid);
}

async function sendToUser(uid, payload, dedupeKey) {
  const context = await getUserPushContext(uid, new Map());
  if (context.preferences.notifications === false || !context.subscriptions.length) return;
  const results = await Promise.allSettled(context.subscriptions.map(subscriptionDoc =>
    sendToSubscription(uid, subscriptionDoc, payload, dedupeKey)
  ));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

// Public VAPID key only; the corresponding private key is stored in Secret Manager.
exports.getWebPushConfig = onRequest({ region: REGION, cors: true }, (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.status(200).json({ vapidPublicKey: VAPID_PUBLIC_KEY.value() });
});

// Event-driven team notification delivery.
// Only executes when an actual notification record is created in Firestore.
// Consumes zero idle reads and requires zero background scheduler crons.
exports.pushTeamNotification = onDocumentCreated({
  document: 'teams/{teamId}/notifications/{notificationId}',
  region: REGION,
  secrets: [VAPID_PRIVATE_KEY]
}, async event => {
  const notification = event.data?.data();
  if (!notification?.recipientUid) return;
  const notificationId = event.params.notificationId;
  const teamId = event.params.teamId;
  const type = String(notification.type || 'team');
  const payload = makePayload(
    notification.title || 'Chronos team update',
    notification.message || 'A new update is available in your team workspace.',
    `team-${teamId}-${notificationId}`,
    {
      kind: 'team-update',
      teamId,
      notificationId,
      targetType: String(notification.targetType || type),
      targetId: String(notification.targetId || '')
    }
  );
  await sendToUser(
    String(notification.recipientUid),
    payload,
    `team:${teamId}:${notificationId}`
  );
});
