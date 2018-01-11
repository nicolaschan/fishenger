const config = require('./config.json')

const async = require('async')
const math = require('mathjs')
const rp = require('request-promise')
const mineflayer = require('mineflayer')
var navigatePlugin = require('mineflayer-navigate')(mineflayer)
const vec3 = require('vec3')

var bot

var tokens = {}

var usernameById = async function (userId) {
  var user = await rp(`${config.market.api}/api/users/${userId}`)
  if (user) {
    user = JSON.parse(user)
    return user.username
  }
}
var idByUsername = async function (username) {
  var user = await rp(`${config.market.api}/api/users?username=${username}`)
  if (user) {
    user = JSON.parse(user)
    return user.user_id
  }
}
var ownUsername = function (username) {
  var userId = getToken(username).userId
  return usernameById(userId)
}
var getToken = function (username) {
  var token = tokens[username]
  if (!token) { throw new Error(`No token! Set token with '${config.prefix}m token <token>'`) }
  return token
}
var getBalance = async function (username) {
  var user = await rp(`${config.market.api}/api/users?username=${username}`)
  if (user) {
    user = JSON.parse(user)
    return `${user.username}: ${user.balance}`
  }
  throw new Error('User not found')
}
var getUsers = async function (username) {
  if (!username) {
    var users = JSON.parse(await rp(`${config.market.api}/api/users`))
    return users.reduce((acc, user, i) => `${(i > 0) ? acc + ', ' : ''}${user.username}`, '')
  } else {
    try {
      var user = JSON.parse(await rp(`${config.market.api}/api/users?username=${username}`))
    } catch (e) {
      throw new Error('No such user')
    }
    return `${user.username} (id:${user.user_id}): ${user.balance}`
  }
}
var setToken = async function (username, token) {
  var tokenData = JSON.parse(await rp(`${config.market.api}/api/tokens/${token}`))
  if (tokenData.error) { throw new Error(tokenData.error) }
  var userId = tokenData.user_id
  var user = JSON.parse(await rp(`${config.market.api}/api/users/${userId}`))
  tokens[username] = {
    userId,
    token
  }
  return `Token set for ${user.username}`
}
var send = async function (sender, recipient, amount, memo) {
  var token = getToken(sender).token
  recipient = JSON.parse(await rp(`${config.market.api}/api/users?username=${recipient}`)).user_id

  var result = JSON.parse(await rp({
    method: 'POST',
    uri: `${config.market.api}/api/transactions`,
    form: { token, recipient, amount, memo }
  }))
  return (result.success) ? 'Transaction succeeded' : result.error
}
var transactionToString = async function (transaction) {
  var sender = await usernameById(transaction.sender)
  var recipient = await usernameById(transaction.recipient)
  return `${sender} -> ${recipient}: ${transaction.amount} ${transaction.memo ? `(${transaction.memo})` : ''}`
}
var transactions = async function (user) {
  var userId = await idByUsername(user)
  var transactions = JSON.parse(await rp(`${config.market.api}/api/transactions/${userId}?limit=3`))
  return (await Promise.all(
    transactions.sort((a, b) => a.transaction_id - b.transaction_id).map(transactionToString))).join('\n')
}

var market = async function (username, command, ...args) {
  switch (command) {
    case 'balance': return getBalance(args[0] || await ownUsername(username))
    case 'users': return getUsers(args[0])
    case 'token': return setToken(username, args[0])
    case 'send': return send(username, args[0], args[1], args.slice(2).join(' '))
    case 'transactions': return transactions(args[0] || await ownUsername(username))
    case 'help': return 'balance, users, token, send, transactions'
  }
}

var route = function (username, x, y, z) {
  if (x === 'here') {
    var target = bot.players[username].entity
    bot.navigate.to(target.position)
  } else {
    x = parseFloat(x)
    y = parseFloat(y)
    z = parseFloat(z)
    bot.navigate.to(vec3(x, y, z))
  }
  return ''
}
var look = function (username, pitch, yaw) {
  bot.look(parseFloat(pitch), parseFloat(yaw), true)
  return ''
}

var fishing = false
var fish = function () {
  if (!fishing) return
  bot.activateItem()
  setTimeout(function () {
    var active = true
    bot.on('entityMoved', function (entity) {
      if (!active) return
      if (entity.objectType === 'Fishing Hook' && Math.abs(entity.velocity.y) > 0.1) {
        bot.activateItem()
        active = false
        fish()
      }
    })
  }, 2000)
}

var commands = {
  echo: (username, ...args) => args.join(' '),
  disconnect: () => bot.quit(),
  m: market,
  help: () => Object.keys(commands),
  whoami: (username) => username,
  route: route,
  stop: () => bot.navigate.stop(),
  locate: () => `(${bot.entity.position.x}, ${bot.entity.position.y}, ${bot.entity.position.z})`,
  look: look,
  ping: () => 'Pong!',
  activate: () => {
    bot.activateItem()
    return ''
  },
  deactivate: () => {
    bot.deactivateItem()
    return ''
  },
  toss: () => {
    bot.toss(bot.heldItem.type, null, null)
    return ''
  },
  dump: () => {
    var inventory = bot.inventory.slots
    var items = []
    for (var item in inventory) {
      if (!inventory[item]) continue
      items.push({
        type: inventory[item].type,
        count: inventory[item].count
      })
    }
    async.forEachSeries(items, function (item, callback) {
      bot.toss(item.type, null, item.count, function (err) {
        if (err) console.log(err)
        callback()
      })
    })
    return 'Dumping all items'
  },
  fish: () => {
    var startFishing = function () {
      fishing = true
      fish()
      return 'Started fishing'
    }
    var stopFishing = function () {
      fishing = false
      bot.activateItem()
      return 'Stopped fishing'
    }
    var toggleFishing = function () {
      if (!fishing) {
        return startFishing()
      }
      return stopFishing()
    }
    return toggleFishing()
  }
}

var match = function (obj, [key, ...keys]) {
  if (key === undefined) {
    return obj
  }
  try {
    return match(obj[key], keys)
  } catch (e) {
    return null
  }
}

var respond = async function (message, username, prefix = '') {
  try {
    var result = math.eval(message)
    if (typeof result === 'number' || typeof result === 'string') {
      return result.toString()
    }
  } catch (e) {}

  if (message.indexOf(prefix) === 0) {
    message = message.substring(prefix.length)
    var [command, ...args] = message.split(' ')
      .map(str => str.trim()).filter(str => str.length)
    var f = commands[command]

    if (!f) {
      f = async () => match(bot, [command, ...args])
    }

    try {
      var response = await f.apply(this, [username, ...args])
    } catch (e) {
      return e.message
    }
    if (typeof response !== 'string') {
      response = JSON.stringify(response)
    }
    if (typeof response === 'undefined') {
      response = 'Unknown command'
    }
    return response
  }
  return ''
}

var initializeBot = function () {
  bot = mineflayer.createBot(config.login)
  navigatePlugin(bot)

  bot.navigate.on('pathFound', function (path) {
    bot.chat(`Routed! ${path.length} moves to destination`)
  })
  bot.navigate.on('cannotFind', function (closestPath) {
    bot.chat('Cannot find route to destination')
  })
  bot.navigate.on('arrived', function () {
    bot.chat(`Arrived at (${bot.entity.position.x}, ${bot.entity.position.y}, ${bot.entity.position.z})`)
  })
  bot.navigate.on('interrupted', function () {
    bot.chat(`Stopped at (${bot.entity.position.x}, ${bot.entity.position.y}, ${bot.entity.position.z})`)
  })

  bot.on('whisper', async (username, message) => {
    if (username === bot.username) { return }
    bot.whisper(username, await respond(message, username))
  })

  bot.on('chat', async (username, message) => {
    if (username === bot.username) { return }
    bot.chat(await respond(message, username, config.prefix))
  })

  bot.on('spawn', () => {
    bot.chat(`Ready! I'm a bot with prefix ${config.prefix}`)
  })

  bot.on('end', () => {
    setTimeout(initializeBot, 5000)
  })
  bot.on('kicked', () => {
    setTimeout(initializeBot, 5000)
  })
}
initializeBot()
