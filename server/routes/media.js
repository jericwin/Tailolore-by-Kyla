// Serves stored images with access checks.
//  /media/g/:file      gown photographs — public once the gown is published, studio-only before
//  /media/p/:id/:size  inspiration images — only the customer who sent them, and the studio
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { HttpError } = require('../lib/errors');

const router = express.Router();
const GOWN_FILE = /^([a-z0-9]{10,40})(-cut|-studio)?-(480|960|1600|2400)\.webp$/i;

router.get('/media/g/:file', (req, res, next) => {
  const m = GOWN_FILE.exec(req.params.file);
  if (!m) return next(new HttpError(404, 'Not found'));
  // A photograph may be used by several listings; the most public one decides.
  const row = db.one(
    `SELECT g.listing_status FROM gown_images i JOIN gowns g ON g.id = i.gown_id WHERE i.file_key = ?
      ORDER BY g.listing_status = 'published' DESC, g.listing_status = 'draft' ASC LIMIT 1`, m[1]);
  const isAdmin = req.user?.role === 'admin';
  // Library photographs not used by any listing are visible to the studio only.
  if (!row && isAdmin && db.one('SELECT 1 FROM library_images WHERE file_key = ?', m[1])) {
    let file = path.join(config.storage.gowns, req.params.file);
    if (!fs.existsSync(file)) file = path.join(config.root, 'storage', 'gowns', req.params.file);
    if (!fs.existsSync(file)) return next(new HttpError(404, 'Not found'));
    res.set('Cache-Control', 'private, no-store');
    return res.type('image/webp').sendFile(file);
  }
  // Drafts stay private until first published. Thumbnails of gowns that were once public
  // remain viewable so customers' order history keeps its pictures after a gown is withdrawn.
  const visible = row && (isAdmin || row.listing_status === 'published'
    || (req.user && row.listing_status !== 'draft' && m[3] === '480'));
  if (!visible) return next(new HttpError(404, 'Not found'));
  let file = path.join(config.storage.gowns, req.params.file);
  if (!fs.existsSync(file)) file = path.join(config.root, 'storage', 'gowns', req.params.file);
  if (!fs.existsSync(file)) return next(new HttpError(404, 'Not found'));
  res.set('Cache-Control', row.listing_status === 'published'
    ? 'public, max-age=604800' : 'private, no-store');
  res.type('image/webp').sendFile(file);
});

router.get('/media/p/:id/:size', (req, res, next) => {
  if (!req.user) return next(new HttpError(404, 'Not found'));
  const size = req.params.size === 'thumb' ? 480 : 1600;
  const row = db.one(
    `SELECT i.file_key, r.customer_id FROM custom_request_images i
       JOIN custom_requests r ON r.id = i.request_id WHERE i.id = ?`, Number(req.params.id) || 0);
  if (!row || (row.customer_id !== req.user.id && req.user.role !== 'admin')) return next(new HttpError(404, 'Not found'));
  let file = path.join(config.storage.private, `${row.file_key}-${size}.webp`);
  if (!fs.existsSync(file)) file = path.join(config.root, 'storage', 'private', `${row.file_key}-${size}.webp`);
  if (!fs.existsSync(file)) return next(new HttpError(404, 'Not found'));
  res.set('Cache-Control', 'private, no-store');
  res.type('image/webp').sendFile(file);
});

module.exports = router;
