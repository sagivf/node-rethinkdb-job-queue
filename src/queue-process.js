const logger = require('./logger')(module)
const Promise = require('bluebird')
const enums = require('./enums')
const dbReview = require('./db-review')
const dbQueue = require('./db-queue')
const dbJobCompleted = require('./db-job-completed')
const dbJobFailed = require('./db-job-failed')

const jobRun = function (job) {
  logger('jobRun')
  let handled = false
  // console.log('>>>>>>>>>>>>>>>>>>>>>>>>>>>>>')
  // console.dir(job)
  // console.log('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<')
  let jobTimeoutId

  const nextHandler = (err, data) => {
    logger('nextHandler')
    console.dir(err)
    console.dir(data)
    // Ignore mulpiple calls to next()
    if (handled) { return }
    handled = true
    clearTimeout(jobTimeoutId)
    job.q.running--
    let finalPromise
    if (err) {
      finalPromise = dbJobFailed(err, job, data)
    } else {
      finalPromise = dbJobCompleted(job, data)
    }
    return finalPromise.then((finalResult) => {
      return setImmediate(jobTick, job.q)
    })
  }

  const timedOutMessage = 'Job ' + job.id + ' timed out (' + job.timeout + ' sec)'
  jobTimeoutId = setTimeout(nextHandler.bind(null, Error(timedOutMessage)), job.timeout * 1000)
  job.q.handler(job, nextHandler)
}

const jobTick = function (q) {
  logger('jobTick')
  if (q.paused) {
    return
  }

  return dbQueue.getNextJob(q).then((jobsToDo) => {
    if (jobsToDo.length < 1) {
      return Promise.reject(enums.queueStatus.idle)
    }
    return jobsToDo
  }).then((jobsToDo) => {
    logger('jobsToDo', jobsToDo.map(j => j.id))

    for (let jobToDo of jobsToDo) {
      q.running++
      jobRun(jobToDo)
    }
    if (q.running < q.concurrency) {
      setImmediate(jobTick, q)
    }
    return
  }).catch((err) => {
    if (err === enums.queueStatus.idle) {
      logger('queue idle')
      q.emit(enums.queueStatus.idle)
      return
    }
    q.emit(enums.queueStatus.error, err.message)
    return setImmediate(jobTick, q)
  })
}

module.exports = function (q, handler) {
  logger('process')
  if (!q.isWorker) {
    throw Error(enums.error.nonWorker)
  }

  if (q.handler) {
    throw Error(enums.error.processTwice)
  }

  q.handler = handler
  q.running = 0
  return dbReview.jobTimeout(q).then((dbReviewResult) => {
    dbReview.start(q)
    setImmediate(jobTick, q)
    return true
  })
}