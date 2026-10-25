// Conversations between a customer and the studio.
const db = require('../db');
const { notify, notifyStudio } = require('../lib/notify');

function getOrCreate(customerId, subjectType, subjectId, label) {
  const existing = db.one(
    'SELECT * FROM threads WHERE customer_id = ? AND subject_type = ? AND subject_id IS ?',
    customerId, subjectType, subjectId ?? null);
  if (existing) return existing;
  const { lastInsertRowid } = db.run(
    'INSERT INTO threads (customer_id, subject_type, subject_id, subject_label) VALUES (?, ?, ?, ?)',
    customerId, subjectType, subjectId ?? null, label);
  return db.one('SELECT * FROM threads WHERE id = ?', lastInsertRowid);
}

function linkFor(thread, side) {
  return side === 'studio' ? `/studio/messages/${thread.id}` : `/account/messages/${thread.id}`;
}

/** Adds a message and notifies the other side. Replying counts as having read the thread. */
function post(thread, sender, body) {
  const now = new Date().toISOString();
  db.tx(() => {
    db.run('INSERT INTO messages (thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)', thread.id, sender.id, body, now);
    if (sender.role === 'admin') {
      db.run('UPDATE threads SET last_message_at = ?, customer_unread = customer_unread + 1, studio_unread = 0 WHERE id = ?', now, thread.id);
      notify(thread.customer_id, {
        kind: 'message', title: 'New message from Kyla', body: thread.subject_label, link: linkFor(thread, 'customer'),
      });
    } else {
      db.run('UPDATE threads SET last_message_at = ?, studio_unread = studio_unread + 1, customer_unread = 0 WHERE id = ?', now, thread.id);
      notifyStudio({
        kind: 'message', title: `Message from ${sender.fullName}`, body: thread.subject_label, link: linkFor(thread, 'studio'),
      });
    }
  });
}

function messages(threadId) {
  return db.all(
    `SELECT m.*, u.full_name AS sender_name, u.role AS sender_role
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.thread_id = ? ORDER BY m.created_at, m.id`, threadId);
}

/** The thread attached to a rental/order/custom request, if any, with its messages. */
function forSubject(customerId, subjectType, subjectId) {
  const t = db.one('SELECT * FROM threads WHERE customer_id = ? AND subject_type = ? AND subject_id = ?',
    customerId, subjectType, subjectId);
  return t ? { ...t, messages: messages(t.id) } : null;
}

module.exports = { getOrCreate, post, messages, forSubject };
