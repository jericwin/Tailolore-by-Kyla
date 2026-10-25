// Status vocabularies and the transitions the studio may make.
// Customer-side transitions (cancel, accept/decline a quotation) are handled
// explicitly in the customer routes.

const RENTAL = {
  requested:        { label: 'Requested',          tone: 'pending', note: 'Waiting for Kyla to review. Your dates are not held yet.' },
  awaiting_deposit: { label: 'Approved — deposit due', tone: 'action', note: 'Approved. Dates are held for you; the booking is confirmed once the deposit is received.' },
  confirmed:        { label: 'Confirmed',          tone: 'ok',      note: 'Your booking is confirmed.' },
  picked_up:        { label: 'With you',           tone: 'ok',      note: 'The gown has been picked up.' },
  returned:         { label: 'Returned',           tone: 'neutral', note: 'The gown has been returned and is being checked.' },
  completed:        { label: 'Completed',          tone: 'neutral', note: 'This rental is complete.' },
  rejected:         { label: 'Declined',           tone: 'closed',  note: 'Kyla was unable to accept this request.' },
  cancelled:        { label: 'Cancelled',          tone: 'closed',  note: 'This request was cancelled.' },
};
// Statuses that hold a physical piece for the requested dates.
const RENTAL_HOLDING = ['awaiting_deposit', 'confirmed', 'picked_up'];
const RENTAL_FLOW = {
  requested:        ['awaiting_deposit', 'confirmed', 'rejected', 'cancelled'],
  awaiting_deposit: ['confirmed', 'cancelled'],
  confirmed:        ['picked_up', 'cancelled'],
  picked_up:        ['returned'],
  returned:         ['completed'],
  completed:        [],
  rejected:         [],
  cancelled:        [],
};

const ORDER = {
  pending:    { label: 'Pending confirmation', tone: 'pending', note: 'Kyla will confirm availability and send payment details. Nothing has been charged.' },
  confirmed:  { label: 'Confirmed',            tone: 'action',  note: 'Kyla confirmed this order. Payment arrangements are shown below.' },
  processing: { label: 'Being prepared',       tone: 'ok',      note: 'Your gown is being prepared.' },
  ready:      { label: 'Ready',                tone: 'ok',      note: 'Ready for pickup or delivery.' },
  completed:  { label: 'Completed',            tone: 'neutral', note: 'This order is complete.' },
  cancelled:  { label: 'Cancelled',            tone: 'closed',  note: 'This order was cancelled.' },
};
const ORDER_FLOW = {
  pending:    ['confirmed', 'cancelled'],
  confirmed:  ['processing', 'ready', 'cancelled'],
  processing: ['ready', 'cancelled'],
  ready:      ['completed', 'cancelled'],
  completed:  [],
  cancelled:  [],
};
const PAYMENT = {
  unpaid:         'Not yet paid',
  partially_paid: 'Partially paid',
  verified:       'Payment verified',
  refunded:       'Refunded',
};
const DEPOSIT = {
  not_required:       'No deposit',
  not_received:       'Not received',
  received:           'Received',
  refunded:           'Refunded',
  partially_refunded: 'Partly refunded',
  withheld:           'Withheld',
};

const CUSTOM = {
  pending_review:    { label: 'Pending review',    tone: 'pending', note: 'Kyla is reviewing your request.' },
  quotation_sent:    { label: 'Quotation sent',    tone: 'action',  note: 'A quotation is waiting for your response.' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'pending', note: 'You accepted the quotation. Kyla will confirm the agreement and next steps.' },
  approved:          { label: 'Approved',          tone: 'ok',      note: 'Both sides have agreed. Work will be scheduled.' },
  in_progress:       { label: 'In progress',       tone: 'ok',      note: 'Your gown is being made.' },
  ready_for_fitting: { label: 'Ready for fitting', tone: 'action',  note: 'Your gown is ready for a fitting.' },
  completed:         { label: 'Completed',         tone: 'neutral', note: 'This commission is complete.' },
  cancelled:         { label: 'Cancelled',         tone: 'closed',  note: 'This request was cancelled.' },
};
// quotation_sent is reached by sending a quotation; awaiting_approval by the customer accepting.
const CUSTOM_FLOW = {
  pending_review:    ['cancelled'],
  quotation_sent:    ['pending_review', 'cancelled'],
  awaiting_approval: ['approved', 'pending_review', 'cancelled'],
  approved:          ['in_progress', 'cancelled'],
  in_progress:       ['ready_for_fitting', 'completed', 'cancelled'],
  ready_for_fitting: ['in_progress', 'completed', 'cancelled'],
  completed:         [],
  cancelled:         [],
};

const LISTING = {
  draft: 'Draft', published: 'Published', unpublished: 'Unpublished', archived: 'Archived',
};
const AVAILABILITY = {
  available: 'Available', reserved: 'Reserved', rented: 'Rented', sold: 'Sold', unavailable: 'Unavailable',
};

function canMove(flow, from, to) {
  return (flow[from] || []).includes(to);
}

// The steps a customer sees for each kind of request, and which statuses belong to each step.
// Declined and cancelled requests have no progress to show.
const STEPS = {
  rental: [['Requested', ['requested']], ['Approved', ['awaiting_deposit']], ['Confirmed', ['confirmed']],
    ['With you', ['picked_up']], ['Returned', ['returned']], ['Completed', ['completed']]],
  order: [['Placed', ['pending']], ['Confirmed', ['confirmed']], ['Being prepared', ['processing']],
    ['Ready', ['ready']], ['Completed', ['completed']]],
  custom: [['In review', ['pending_review']], ['Quotation', ['quotation_sent']], ['Agreement', ['awaiting_approval', 'approved']],
    ['Being made', ['in_progress']], ['Fitting', ['ready_for_fitting']], ['Completed', ['completed']]],
};

/** Steps with done / current / todo states, or null when the request has stopped. */
function progress(kind, status) {
  const steps = STEPS[kind] || [];
  const at = steps.findIndex(([, statuses]) => statuses.includes(status));
  if (at < 0) return null;
  return steps.map(([label], i) => ({ label, state: i < at ? 'done' : i === at ? 'current' : 'todo' }));
}

module.exports = {
  RENTAL, RENTAL_FLOW, RENTAL_HOLDING, ORDER, ORDER_FLOW, PAYMENT, DEPOSIT, CUSTOM, CUSTOM_FLOW,
  LISTING, AVAILABILITY, STEPS, canMove, progress,
};
