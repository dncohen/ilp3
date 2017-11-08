'use strict'

const assert = require('assert')
const fetch = require('node-fetch')
const Koa = require('koa')
const Router = require('koa-router')
const getRawBody = require('raw-body')
const Debug = require('debug')
const Macaroon = require('macaroon')

const BODY_SIZE_LIMIT = '1mb'

async function send ({ connector, transfer }) {
  // TODO recognize if connector has a macaroon in the URL and caveat it (for a short expiry) if so
  const debug = Debug('ilp3:send')
  debug('sending transfer', transfer)
  const headers = Object.assign({
    'ILP-Amount': transfer.amount,
    'ILP-Expiry': transfer.expiry,
    'ILP-Condition': transfer.condition,
    'ILP-Destination': transfer.destination,
    'User-Agent': '',
    'Content-Type': 'application/octet-stream'
  }, transfer.additionalHeaders || {})
  let response
  try {
    response = await fetch(connector, {
      method: 'POST',
      headers,
      body: transfer.data,
      compress: false
    })
  } catch (err) {
    debug('error sending transfer', err)
    throw err
  }
  if (!response.ok) {
    throw new Error(`Error sending transfer: ${response.status} ${response.statusText}`)
  }

  const fulfillment = response.headers.get('ilp-fulfillment')
  const contentType = response.headers.get('content-type')
  const data = await response.buffer()
  debug(`got fulfillment: ${fulfillment} and data:`, data.toString('base64'))
  return {
    fulfillment,
    data
  }
}

// TODO should this be part of ILP3 or an extension?
function macaroonVerifier ({ secret }) {
  const debug = Debug('ilp3-macaroon:verifier')
  assert(secret, 'secret is required')
  assert(Buffer.from(secret, 'base64').length >= 32, 'secret must be at least 32 bytes')
  return async (ctx, next) => {
    const encoded = ctx.request.path.slice(1)
    debug('got macaroon', encoded)
    try {
      const macaroon = Macaroon.importMacaroon(encoded)
      const account = Buffer.from(macaroon.identifier).toString('utf8')
      debug('macaroon is for account:', account)
      macaroon.verify(secret, (caveat) => {
        throw new Error('unsupported caveat')
      })
      debug('macaroon passed validation')
      ctx.state.account = account
    } catch (err) {
      debug('invalid macaroon', err)
      return ctx.throw(401, 'invalid macaroon')
    }
    return next()
  }
}

function receiverMiddleware () {
  return async (ctx, next) => {
    const debug = Debug('ilp3:receiver')
    const transfer = await getTransferFromRequest(ctx)
    debug('got transfer:', transfer)
    // TODO validate transfer details
    ctx.state.transfer = transfer

    await next()

    if (ctx.state.fulfillment) {
      debug('responding to sender with fulfillment')
      ctx.status = 200
      ctx.set('ILP-Fulfillment', ctx.state.fulfillment)
      ctx.body = ctx.state.data
    }
  }
}

function createReceiver (opts) {
  if (!opts) {
    opts = {}
  }
  const path = opts.path || '*'
  const receiver = new Koa()
  const router = new Router()
  router.post(path, macaroonVerifier({ secret: opts.secret }))
  router.post(path, receiverMiddleware())
  receiver.use(router.routes())
  receiver.use(router.allowedMethods())
  return receiver
}


async function getTransferFromRequest (ctx) {
  const body = await getRawBody(ctx.req, {
    limit: BODY_SIZE_LIMIT
  })
  return {
    amount: ctx.request.headers['ilp-amount'],
    expiry: ctx.request.headers['ilp-expiry'],
    condition: ctx.request.headers['ilp-condition'],
    destination: ctx.request.headers['ilp-destination'],
    data: body
  }
}

exports.send = send
exports.createReceiver = createReceiver
