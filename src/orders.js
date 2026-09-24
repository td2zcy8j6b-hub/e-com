const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// A tiny JSON-file order store. Writes are serialised through a promise chain
// and land via rename, so a crash mid-write never leaves a half-written file.
// Swap for a real database once volume justifies it.
class OrderStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async readAll() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // Runs fn(orders) exclusively; fn mutates the array and returns a result.
  mutate(fn) {
    const run = this.queue.then(async () => {
      const orders = await this.readAll();
      const result = await fn(orders);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(orders, null, 2));
      await fs.rename(tmp, this.file);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  create(data) {
    const order = {
      id: `NN-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      createdAt: new Date().toISOString(),
      status: 'pending_payment',
      ...data,
    };
    return this.mutate((orders) => {
      orders.push(order);
      return order;
    });
  }

  async get(id) {
    return (await this.readAll()).find((o) => o.id === id) || null;
  }

  update(id, patch) {
    return this.mutate((orders) => {
      const order = orders.find((o) => o.id === id);
      if (!order) return null;
      Object.assign(order, typeof patch === 'function' ? patch(order) : patch, { updatedAt: new Date().toISOString() });
      return order;
    });
  }
}

// Order lifecycle: pending_payment -> paid -> ordered_from_supplier -> shipped
//                                          \-> refunded / cancelled
const STATUSES = ['pending_payment', 'paid', 'ordered_from_supplier', 'shipped', 'cancelled', 'refunded'];

module.exports = { OrderStore, STATUSES };
