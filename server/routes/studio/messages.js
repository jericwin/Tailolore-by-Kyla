const express = require('express');
const db = require('../../db');
const threads = require('../../models/threads');
const { HttpError } = require('../../lib/errors');

const router = express.Router();

const SUBJECT_LINKS = { rental: 'rentals', order: 'orders', custom: 'custom' };

router.get('/', (req, res) => {
  const unreadOnly = req.query.view === 'unread';
  res.render('studio/messages.njk', {
    section: 'messages', unreadOnly,
    threads: db.all(
      `SELECT t.*, u.full_name AS customer,
              (SELECT body FROM messages WHERE thread_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body
         FROM threads t JOIN users u ON u.id = t.customer_id
        ${unreadOnly ? 'WHERE t.studio_unread > 0' : ''}
        ORDER BY t.last_message_at DESC LIMIT 300`),
  });
});

function load(id) {
  const t = db.one(
    `SELECT t.*, u.full_name AS customer, u.email AS customer_email, u.phone AS customer_phone
       FROM threads t JOIN users u ON u.id = t.customer_id WHERE t.id = ?`, Number(id) || 0);
  if (!t) throw new HttpError(404, 'Conversation not found.');
  return t;
}

router.get('/:id', (req, res) => {
  const thread = load(req.params.id);
  db.run('UPDATE threads SET studio_unread = 0 WHERE id = ?', thread.id);
  // The menu count was taken before this thread was read; refresh it.
  if (res.locals.studioCounts) {
    res.locals.studioCounts.messages = db.one('SELECT COALESCE(SUM(studio_unread > 0), 0) AS n FROM threads').n;
  }
  let subjectLink = SUBJECT_LINKS[thread.subject_type] ? `/studio/${SUBJECT_LINKS[thread.subject_type]}/${thread.subject_id}` : null;
  if (thread.subject_type === 'gown') subjectLink = `/studio/gowns/${thread.subject_id}`;
  res.render('studio/thread.njk', { section: 'messages', thread, subjectLink, messages: threads.messages(thread.id) });
});

router.post('/:id', (req, res) => {
  const thread = load(req.params.id);
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) throw new HttpError(422, 'Please write a message (up to 4,000 characters).');
  threads.post(thread, req.user, body);
  res.redirect(`/studio/messages/${thread.id}#latest`);
});

module.exports = router;
