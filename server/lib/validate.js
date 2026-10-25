// Small form validator. Each call reads one field from the submitted body,
// normalises it and records an error message; done() throws if anything failed.
const { ValidationError } = require('./errors');
const { isValidDate } = require('./dates');

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/;

function form(body = {}) {
  const values = {};
  const errors = {};

  const raw = (name) => {
    const v = body[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const str = (name) => {
    const v = raw(name);
    return v === undefined || v === null ? '' : String(v).replace(/\r\n/g, '\n').trim();
  };

  const api = {
    values,
    errors,
    fail(name, message) { errors[name] = message; return api; },

    text(name, { required = false, max = 500, min = 0, label = 'This field' } = {}) {
      const v = str(name);
      if (!v) {
        if (required) errors[name] = `${label} is required.`;
        values[name] = null;
      } else if (v.length > max) {
        errors[name] = `Please keep this under ${max} characters.`;
      } else if (v.length < min) {
        errors[name] = `Please write at least ${min} characters.`;
      } else {
        values[name] = v;
      }
      return api;
    },

    email(name, { required = true } = {}) {
      const v = str(name).toLowerCase();
      if (!v) { if (required) errors[name] = 'Email is required.'; values[name] = null; }
      else if (v.length > 254 || !EMAIL_RE.test(v)) errors[name] = 'Please enter a valid email address.';
      else values[name] = v;
      return api;
    },

    phone(name, { required = false } = {}) {
      const v = str(name);
      if (!v) { if (required) errors[name] = 'A phone number is required.'; values[name] = null; }
      else if (!/^[+\d][\d\s()-]{6,24}$/.test(v)) errors[name] = 'Please enter a valid phone number.';
      else values[name] = v;
      return api;
    },

    date(name, { required = false, label = 'Date' } = {}) {
      const v = str(name);
      if (!v) { if (required) errors[name] = `${label} is required.`; values[name] = null; }
      else if (!isValidDate(v)) errors[name] = 'Please choose a valid date.';
      else values[name] = v;
      return api;
    },

    /** Peso amount typed by a person ("12,500" or "12500.50") → integer centavos. */
    money(name, { required = false, label = 'Amount' } = {}) {
      const v = str(name).replace(/[₱,\s]/g, '').replace(/^php/i, '');
      if (!v) { if (required) errors[name] = `${label} is required.`; values[name] = null; }
      else if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) errors[name] = 'Enter an amount in pesos, e.g. 12500.';
      else values[name] = Math.round(Number(v) * 100);
      return api;
    },

    int(name, { required = false, min = 0, max = 100000, label = 'Number' } = {}) {
      const v = str(name);
      if (!v) { if (required) errors[name] = `${label} is required.`; values[name] = null; }
      else if (!/^-?\d+$/.test(v) || Number(v) < min || Number(v) > max) errors[name] = `Enter a whole number from ${min} to ${max}.`;
      else values[name] = Number(v);
      return api;
    },

    bool(name) {
      const v = str(name);
      values[name] = ['1', 'on', 'true', 'yes'].includes(v.toLowerCase()) ? 1 : 0;
      return api;
    },

    oneOf(name, allowed, { required = true, fallback = null, label = 'Option' } = {}) {
      const v = str(name);
      if (!v) { if (required && fallback === null) errors[name] = `${label} is required.`; values[name] = fallback; }
      else if (!allowed.includes(v)) errors[name] = 'Please choose one of the options.';
      else values[name] = v;
      return api;
    },

    id(name, { required = false } = {}) {
      return api.int(name, { required, min: 1, max: Number.MAX_SAFE_INTEGER, label: 'Selection' });
    },

    ok() { return Object.keys(errors).length === 0; },

    done(message) {
      if (!api.ok()) throw new ValidationError(errors, message);
      return values;
    },
  };
  return api;
}

module.exports = { form, EMAIL_RE };
