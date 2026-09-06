// Open Library — book metadata by ISBN. Keyless.
import { fetchJson, cached, required } from './_common.js';

export default {
  name: 'openlibrary',
  description: 'Book metadata (title, author, cover) by ISBN. Keyless.',
  paramSchema: [
    { key: 'isbn', label: 'ISBN', type: 'text', placeholder: '9780134685991', helper: 'ISBN-10 or ISBN-13 (digits only)', required: true, source: 'path' },
  ],
  needsKey: null,
  async run({ isbn }) {
    const q = required(isbn, 'isbn').replace(/[^\dxX]/g, '');
    return cached(`openlib:${q}`, 24 * 60 * 60 * 1000, () =>
      fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(q)}&format=json&jscmd=data`, {
        // Open Library can be slow — give it more headroom than the default.
        signal: AbortSignal.timeout(25000),
      }));
  },
};
