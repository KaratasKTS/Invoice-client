'use strict';
// Long operations (fetch, sync) run as jobs. The page starts one and then
// polls it for progress. Only one job runs at a time, which also keeps the
// archive index consistent.

const crypto = require('node:crypto');

const MAX_KEPT_JOBS = 20;
const MAX_LOG_LINES = 500;

class JobBusyError extends Error {
  constructor(job) {
    super(`Another operation is still running: ${job.title}`);
    this.name = 'JobBusyError';
    this.job = job;
  }
}

class Jobs {
  constructor() {
    this.jobs = new Map();
    this.running = null;
  }

  /**
   * Starts fn(ctx) in the background and returns the job right away.
   * ctx.log(message, level) adds a log line, ctx.progress(done, total) sets progress.
   */
  start(type, title, fn) {
    if (this.running) throw new JobBusyError(this.running);

    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      type,
      title,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      log: [],
      progress: null,
      result: null,
      error: null,
    };

    const ctx = {
      log: (message, level = 'info') => {
        job.log.push({ time: Date.now(), level, message: String(message) });
        if (job.log.length > MAX_LOG_LINES) job.log.shift();
      },
      progress: (done, total) => { job.progress = { done, total }; },
    };

    this.jobs.set(job.id, job);
    this.running = job;

    job.promise = Promise.resolve()
      .then(() => fn(ctx))
      .then((result) => {
        job.status = 'done';
        job.result = result === undefined ? null : result;
      })
      .catch((err) => {
        job.status = 'error';
        job.error = err && err.message ? err.message : String(err);
        ctx.log(job.error, 'error');
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.running = null;
        this._trim();
      });

    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  /** The job as plain data for the page. */
  static view(job) {
    const { promise, ...data } = job;
    return data;
  }

  _trim() {
    while (this.jobs.size > MAX_KEPT_JOBS) this.jobs.delete(this.jobs.keys().next().value);
  }
}

module.exports = { Jobs, JobBusyError };
