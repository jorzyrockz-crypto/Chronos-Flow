# Chronos Team 3.0 — Firebase Setup

## 1. Configure Firebase
1. Enable Google as a sign-in provider in Firebase Authentication.
2. Create or select your Cloud Firestore database.
3. Add your HTTPS host or localhost to Authentication → Settings → Authorized domains.
4. Open Chronos and configure the existing Firebase web configuration in Settings → Data & Cloud Sync if it is not already configured.

## 2. Publish security rules
Open Firestore Database → Rules and publish the included `firestore.rules`. Review rules before publishing to a live project. These rules preserve user-owned documents under `users/{uid}`, team membership and role controls, shared `events`, `tasks`, and `notes`, and recipient-specific team notifications.

## 3. Team management
- The team owner can promote a member to Admin or demote an Admin to Member.
- An Admin can remove ordinary members. Only the owner can remove an Admin.
- The owner cannot be removed from the member list through these controls.
- A removed member loses access enforced by team membership checks; their personal data and other teams are not intentionally deleted.
- Invitees still sign in with Google and explicitly accept an invitation using the link or code. This version does not add an administrator approval queue before invitation acceptance.

## 4. Notification 2.0
Notifications are stored at `teams/{teamId}/notifications/{notificationId}` and include `recipientUid`. The app queries each team using `where('recipientUid', '==', currentUid)`. The included rules permit recipients to read their own notifications and update only `readAt`. Team members may create notification records only for existing members of that team and only with themselves as actor.

The app attempts to notify other team members when an event or note is shared with a team, and assigned users when a task is assigned. Notifications are written from the browser; there is no Cloud Function or guaranteed background delivery.

## 5. Validation checklist
- Sign in as owner, promote a member to Admin, then demote them.
- Confirm an Admin cannot promote another user to Admin or remove another Admin.
- Remove an ordinary member and verify that member cannot read team documents after refresh.
- Share an event and note; verify other team members receive in-app notifications.
- Assign a task to a member; verify the task appears in their Tasks list and they receive a notification.
- Mark a notification read and verify its unread badge updates in other open sessions.

## Offline and storage
Personal localStorage keys and the `chronos55-media` IndexedDB database are retained. Team collaboration and persistent notification reads require connectivity. Profile photos use Google-provided `photoURL` values with initials fallback.


## Membership management panel

After deploying this build, select a team and open the **Manage members** tab. It is visible only to the team owner or an authorized administrator. If the app still shows the old interface, hard-refresh the browser or clear the old PWA cache after deployment.
