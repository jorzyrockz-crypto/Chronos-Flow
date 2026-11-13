# Chronos Team 3.0 — Firebase Setup

## 1. Configure Firebase
1. Enable Google as a sign-in provider in Firebase Authentication.
2. Create or select your Cloud Firestore database.
3. Add your HTTPS host or localhost to Authentication → Settings → Authorized domains.
4. Open Chronos and configure the existing Firebase web configuration in Settings → Data & Cloud Sync if it is not already configured.

### Installed-PWA Google sign-in

Chronos uses Firebase's popup sign-in flow in both the browser and installed PWA. This avoids the cross-origin redirect-storage problem that can return to an Android app without a Firebase session. Keep the existing Firebase `authDomain` (`russapps-chronosflow.firebaseapp.com`) unless a fully tested same-origin Firebase Auth proxy and matching Google OAuth redirect URI have been configured.

After deploying an update, use the PWA's update action if offered, then close and reopen Chronos before testing sign-in, sign-out, and sign-in again. If Android blocks or closes the popup, use **Open Chronos in browser** in the sign-in dialog, complete authentication there, then return to Chronos and reload it if needed.

## 2. Publish security rules
Open Firestore Database → Rules and publish the included `firestore.rules`. Review rules before publishing to a live project. These rules preserve user-owned documents under `users/{uid}`, team membership and role controls, shared `events`, `tasks`, and `notes`, and recipient-specific team notifications.

## 3. Team management
- The team owner can promote a member to Admin or demote an Admin to Member.
- An Admin can remove ordinary members. Only the owner can remove an Admin.
- The owner cannot be removed from the member list through the member-management controls.
- The owner can permanently delete a team. Deletion first locks team writes and invitations, then clears shared records, tombstones, invitation and invite-code indexes, active member records, and user-side membership indexes; the owner membership record is removed atomically with the team document. If cleanup is interrupted, retry deletion as owner to finish.
- Publish the included `firestore.rules` before using team deletion so the owner and team cleanup permissions are active.
- A removed member loses access enforced by team membership checks; their personal data and other teams are not intentionally deleted.
- Invitees still sign in with Google and explicitly accept an invitation using the link or code. This version does not add an administrator approval queue before invitation acceptance.

## 4. Notification 2.0
Notifications are stored at `teams/{teamId}/notifications/{notificationId}` and include `recipientUid`. The app queries each team using `where('recipientUid', '==', currentUid)`. The included rules permit recipients to read their own notifications and update only `readAt`. Team members may create notification records only for existing members of that team and only with themselves as actor.

The app attempts to notify other team members when an event or note is shared with a team, and assigned users when a task is assigned. Notifications are recorded in Firestore by the browser. The included `functions/` package adds optional Web Push delivery for those records; recipients must opt in on each browser/device. In-app notifications remain available if push is not configured.

## 5. Browser push notifications

Chronos uses standards-based Web Push (VAPID). The app stores each opted-in browser subscription at `users/{uid}/pushSubscriptions/{subscriptionId}`. The VAPID public key is served by `getWebPushConfig`; the private key is only used by Firebase Functions and must never be placed in the app or Git.

1. Select the same Firebase project used by Chronos and ensure Firebase CLI is installed/logged in. From the repository root, install the function dependencies:
   ```bash
   npm --prefix functions install
   ```
2. Generate a VAPID key pair:
   ```bash
   node -e "console.log(require('./functions/node_modules/web-push').generateVAPIDKeys())"
   ```
   Keep the `privateKey` private. Set it through the Firebase secret prompt (do not put it in a command argument or source file):
   ```bash
   firebase functions:secrets:set VAPID_PRIVATE_KEY --project YOUR_PROJECT_ID
   ```
3. Deploy the functions and rules from the repository root:
   ```bash
   firebase deploy --project YOUR_PROJECT_ID --only functions,firestore:rules
   ```
   On first deploy, Firebase CLI prompts for `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT`. Enter the matching generated public key and a valid contact such as `mailto:you@example.com`. The `.env.<project-id>` parameter file is ignored by Git.
4. In Chronos, sign in with Google, open **Settings → Notifications**, and choose **Enable push notifications** in each browser/device. Allow the browser permission. **HTTPS is required** (localhost is suitable for development).
5. Complete **Settings → Data & Cloud Sync → Merge & sync data** on devices that have not yet synced their local calendar/tasks. Scheduled reminders are sent from the Firestore copies of personal events and tasks. Team activity push is triggered by the existing team notification records.

Firebase Functions (2nd gen) team notifications are event-driven (`onDocumentCreated`), meaning they only run when a team item is posted and consume zero idle reads.

> [!IMPORTANT]
> **Firestore Read Quota Protection (Spark 50K/day limit):**
> Previously, the legacy `dispatchDueReminders` function executed a 1-minute `collectionGroup` scheduled sweep across Firestore documents, which generates ~1.6M reads/day and quickly triggers the `100% of your quota has been used (50K / day)` alert.
> In this build, `dispatchDueReminders` is safely disabled (zero Firestore reads). Personal event and task reminders are handled directly on-device in the PWA by `checkReminders()` in `index.html` at zero cloud cost.
>
> **How to immediately halt active read quota consumption:**
> 1. Open the [Google Cloud Cloud Scheduler Console](https://console.cloud.google.com/cloudscheduler?project=russapps-chronosflow) or [Firebase Functions Console](https://console.firebase.google.com/project/russapps-chronosflow/functions).
> 2. Find the scheduled job `firebase-schedule-dispatchDueReminders-us-central1` and click **Pause** or **Delete**.
> 3. To redeploy the zero-read functions package from your CLI:
>    ```bash
>    npx firebase-tools login
>    npx firebase-tools deploy --project russapps-chronosflow --only functions
>    ```

## 6. Validation checklist
- Enable push on a recipient browser, close/minimize Chronos, then share a team event/note or assign a task and confirm a system notification arrives.
- Add a future personal event with a reminder and a task with a due-date reminder; confirm each push is delivered once and quiet hours are respected.
- Disable push on a browser and verify its subscription is removed while in-app notifications still work.
- Sign in as owner, promote a member to Admin, then demote them.
- Confirm an Admin cannot promote another user to Admin or remove another Admin.
- Remove an ordinary member and verify that member cannot read team documents after refresh.
- On a disposable test team with multiple members, invitations, records, and notifications, delete the team as owner; verify the team and membership links are removed while personal data and other teams remain.
- During team deletion, verify new invitations, joins, and shared writes are blocked; after an interrupted cleanup, retry as owner and confirm it finishes.
- Share an event and note; verify other team members receive in-app notifications.
- Assign a task to a member; verify the task appears in their Tasks list and they receive a notification.
- Mark a notification read and verify its unread badge updates in other open sessions.

## Offline and storage
Personal localStorage keys and the `chronos55-media` IndexedDB database are retained. Team collaboration and persistent notification reads require connectivity. Profile photos use Google-provided `photoURL` values with initials fallback.


## Membership management panel

After deploying this build, select a team and open the **Manage members** tab. It is visible only to the team owner or an authorized administrator. If the app still shows the old interface, hard-refresh the browser or clear the old PWA cache after deployment.
