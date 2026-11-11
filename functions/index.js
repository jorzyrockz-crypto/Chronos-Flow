'use strict';

const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const webpush = require('web-push');
const { DateTime } = require('luxon');
const { defineSecret, defineString } = require('firebase-functions/params');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

initializeApp();
const db = getFirestore();
const REGION = 'us-central1';
const VAPID_PUBLIC_KEY = defineString('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = defineString('VAPID_SUBJECT');

const DEFAULT_PREFERENCES = {
  notifications: true,
  leadTime: 10,
  quietHours: true,
  quietStart: '22:00',
  quietEnd: '07:00'
};

function configureWebPush() {
  webpush.setVapidDetails(
    VAPID_SUBJECT.value(),
    VAPID_PUBLIC_KEY.value(),
    VAPID_PRIVATE_KEY.value()
  );
}

function safeTimeZone(value) {
  const zone = typeof value === 'string' && value.trim() ? value.trim() : 'UTC';
  return DateTime.now().setZone(zone).isValid ? zone : 'UTC';
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

async function getUserPushContext(uid, cache) {
  if (!cache.has(uid)) {
    cache.set(uid, (async () => {
      const userRef = db.collection('users').doc(uid);
      const [preferencesSnapshot, subscriptionsSnapshot] = await Promise.all([
        userRef.collection('settings').doc('preferences').get(),
        userRef.collection('pushSubscriptions').get()
      ]);
      const saved = preferencesSnapshot.exists ? preferencesSnapshot.data() || {} : {};
      const preferences = saved.value || saved.settings || {};
      return {
        preferences: { ...DEFAULT_PREFERENCES, ...preferences },
        subscriptions: subscriptionsSnapshot.docs.filter(doc => doc.data()?.enabled !== false)
      };
    })());
  }
  return cache.get(uid);
}

async function sendToUser(uid, payload, dedupeKey) {
  const context = await getUserPushContext(uid, new Map());
  const results = await Promise.allSettled(context.subscriptions.map(subscriptionDoc =>
    sendToSubscription(uid, subscriptionDoc, payload, dedupeKey)
  ));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function recordOwnerUid(documentRef) {
  const parentDocument = documentRef.parent?.parent;
  if (!parentDocument || parentDocument.parent?.id !== 'users') return null;
  return parentDocument.id;
}

function parseLocalDateTime(date, time, zone) {
  const parsed = DateTime.fromISO(`${date}T${time}`, { zone });
  return parsed.isValid ? parsed : null;
}

function isQuietHours(preferences, instant, zone) {
  if (preferences.quietHours === false) return false;
  const local = instant.setZone(zone);
  const parseClock = (value, fallback) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || fallback));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const start = parseClock(preferences.quietStart, '22:00');
  const end = parseClock(preferences.quietEnd, '07:00');
  if (start === null || end === null) return false;
  const now = local.hour * 60 + local.minute;
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

async function sendReminderToSubscriptions(uid, context, payload, dedupeKey, nowUtc, isEligible) {
  const results = await Promise.allSettled(context.subscriptions.map(async subscriptionDoc => {
    const zone = safeTimeZone(subscriptionDoc.data()?.timeZone);
    if (!isEligible(zone, context.preferences, nowUtc)) return false;
    return sendToSubscription(uid, subscriptionDoc, payload, dedupeKey);
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) console.warn('One or more push reminder deliveries failed', failure.reason);
}

async function processEventReminder(document, nowUtc, contextCache) {
  const uid = recordOwnerUid(document.ref);
  if (!uid) return;
  const event = document.data() || {};
  if (!event.date || (!event.allDay && !event.start)) return;

  const context = await getUserPushContext(uid, contextCache);
  const preferences = context.preferences;
  if (preferences.notifications === false || !context.subscriptions.length) return;
  if (event.reminderMinutes === null) return;

  const rawLead = event.reminderMinutes === undefined ? preferences.leadTime : event.reminderMinutes;
  const lead = Number(rawLead);
  if (!Number.isFinite(lead)) return;
  const leadWindow = Math.max(lead, 1) * 60 * 1000;
  const time = event.allDay ? '09:00' : String(event.start);
  const id = String(event.id || event._chronosId || document.id);
  const dedupeKey = `event:${id}:${event.date}`;

  await sendReminderToSubscriptions(
    uid,
    context,
    makePayload('Chronos event reminder', `${event.title || 'Your event'} is coming up.`, `event-${id}-${event.date}`, {
      kind: 'event-reminder', recordId: id
    }),
    dedupeKey,
    nowUtc,
    (zone, userPreferences, now) => {
      const dueAt = parseLocalDateTime(String(event.date), time, zone);
      if (!dueAt) return false;
      const diff = dueAt.toMillis() - now.toMillis();
      return diff >= 0 && diff <= leadWindow && !isQuietHours(userPreferences, now, zone);
    }
  );
}

async function processTaskReminder(document, nowUtc, contextCache) {
  const uid = recordOwnerUid(document.ref);
  if (!uid) return;
  const task = document.data() || {};
  if (!task.due || task.done || task.status === 'done' || !task.reminder || task.reminder === 'none') return;

  const context = await getUserPushContext(uid, contextCache);
  const preferences = context.preferences;
  if (preferences.notifications === false || !context.subscriptions.length) return;

  const id = String(task.id || task._chronosId || document.id);
  const reminderKey = `task:${id}:${task.due}:${task.dueTime || '09:00'}:${task.reminder}`;
  if (task.reminderFiredKey === reminderKey) return;
  const dueTime = String(task.dueTime || '09:00');

  await sendReminderToSubscriptions(
    uid,
    context,
    makePayload('Chronos task reminder', `${task.title || 'A task'} is due ${task.due}.`, `task-${id}-${task.due}`, {
      kind: 'task-reminder', recordId: id
    }),
    reminderKey,
    nowUtc,
    (zone, userPreferences, now) => {
      let dueAt = parseLocalDateTime(String(task.due), dueTime, zone);
      if (!dueAt) return false;
      if (task.reminder === 'dayBefore') dueAt = dueAt.minus({ days: 1 });
      else if (task.reminder === 'hourBefore') dueAt = dueAt.minus({ hours: 1 });
      else if (task.reminder !== 'atDue') return false;
      return dueAt.toMillis() <= now.toMillis() && !isQuietHours(userPreferences, now, zone);
    }
  );
}

// Public VAPID key only; the corresponding private key is stored in Secret Manager.
exports.getWebPushConfig = onRequest({ region: REGION, cors: true }, (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.status(200).json({ vapidPublicKey: VAPID_PUBLIC_KEY.value() });
});

// Existing team notification documents are the source of push activity alerts.
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

// Scan only near-term personal records. Reminders respect each browser subscription's
// timezone and the user's existing reminder/quiet-hours preferences.
exports.dispatchDueReminders = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'UTC',
  region: REGION,
  secrets: [VAPID_PRIVATE_KEY],
  maxInstances: 1,
  timeoutSeconds: 120
}, async () => {
  const nowUtc = DateTime.utc();
  const fromDate = nowUtc.minus({ days: 3 }).toISODate();
  const throughDate = nowUtc.plus({ days: 3 }).toISODate();
  const [eventsSnapshot, tasksSnapshot] = await Promise.all([
    db.collectionGroup('events')
      .where('date', '>=', fromDate)
      .where('date', '<=', throughDate)
      .get(),
    db.collectionGroup('tasks')
      .where('due', '>=', fromDate)
      .where('due', '<=', throughDate)
      .get()
  ]);

  const contextCache = new Map();
  for (const document of eventsSnapshot.docs) {
    try { await processEventReminder(document, nowUtc, contextCache); }
    catch (error) { console.warn('Could not process event push reminder', document.ref.path, error); }
  }
  for (const document of tasksSnapshot.docs) {
    try { await processTaskReminder(document, nowUtc, contextCache); }
    catch (error) { console.warn('Could not process task push reminder', document.ref.path, error); }
  }
});
