'use strict';
// Long operations (fetch, sync) run as jobs. The page starts one and then
// polls it for progress. Only one job runs at a time, which also keeps the
// archive index consistent. A running job can be stopped.

const crypto = require('node:crypto');

const MAX_KEPT_JOBS = 20;
const MAX_LOG_LINES = 500;

class JobBusyError extends Error {
  constructor(job) {
    super(`Εκτελείται ήδη μια άλλη ενέργεια: ${job.title}`);
    this.name = 'JobBusyError';
    this.job = job;
  }
}

class CancelledError extends Error {
  constructor() {
    super('Η ενέργεια διακόπηκε.');
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

class Jobs {
  constructor() {
    this.jobs = new Map();
    this.running = null;
  }

  /**
   * Starts fn(ctx) in the background and returns the job right away.
   *
   * ctx.log(message, level)   adds a log line
   * ctx.progress(done, total) sets progress
   * ctx.signal                AbortSignal, aborted when the user stops the job
   * ctx.checkCancelled()      throws CancelledError once the job was stopped
   * ctx.downloaded(id)        records a file this run saved to disk
   * ctx.report(result)        the result so far, kept when the job is stopped
   */
  start(type, title, fn) {
    if (this.running) throw new JobBusyError(this.running);

    const controller = new AbortController();

    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      type,
      title,
      status: 'running',     // running | done | error | cancelled
      startedAt: Date.now(),
      finishedAt: null,
      log: [],
      progress: null,
      result: null,
      error: null,
      downloaded: [],        // Drive IDs of the files saved to disk by this run
    };

    const ctx = {
      signal: controller.signal,
      log: (message, level = 'info') => {
        job.log.push({ time: Date.now(), level, message: String(message) });
        if (job.log.length > MAX_LOG_LINES) job.log.shift();
      },
      progress: (done, total) => { job.progress = { done, total }; },
      checkCancelled: () => { if (controller.signal.aborted) throw new CancelledError(); },
      downloaded: (id) => { job.downloaded.push(id); },
      report: (result) => { job.result = result; },
    };

    job.controller = controller;
    this.jobs.set(job.id, job);
    this.running = job;

    job.promise = Promise.resolve()
      .then(() => fn(ctx))
      .then((result) => {
        job.status = 'done';
        if (result !== undefined) job.result = result;
      })
      .catch((err) => {
        if (controller.signal.aborted || (err && err.code === 'CANCELLED')) {
          job.status = 'cancelled';
          ctx.log('Η ενέργεια διακόπηκε.');
          return;
        }
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

  /** Asks a running job to stop. Returns false when it is not running any more. */
  cancel(id) {
    const job = this.get(id);
    if (!job || job.status !== 'running') return false;
    job.controller.abort();
    return true;
  }

  /** The job as plain data for the page. */
  static view(job) {
    const { promise, controller, downloaded, ...data } = job;
    return { ...data, downloadedCount: downloaded.length };
  }

  _trim() {
    while (this.jobs.size > MAX_KEPT_JOBS) this.jobs.delete(this.jobs.keys().next().value);
  }
}

module.exports = { Jobs, JobBusyError, CancelledError };
