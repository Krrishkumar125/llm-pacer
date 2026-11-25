/**
 * One Lua script holds every state change so each call is a single atomic
 * round trip. Time comes from the Redis server (TIME), so clock skew between
 * worker machines does not matter.
 *
 * KEYS[1] = state hash, KEYS[2] = lease sorted set
 * ARGV[1] = op (acquire | settle | observe | penalize | peek)
 * ARGV[2] = rpm, ARGV[3] = tpm, ARGV[4] = rpd, ARGV[5] = concurrency (0 = off)
 * ARGV[6] = window in ms for rpm/tpm/itpm/otpm
 * ARGV[7] = itpm (input tokens), ARGV[8] = otpm (output tokens), 0 = off
 * ARGV[9..] = op arguments
 *
 * Reply: { ok, waitMs, requestsLeft, tokensLeft, dailyLeft, inflight, reason, inputLeft, outputLeft }
 */
export const PACER_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local op = ARGV[1]
local rpm = tonumber(ARGV[2])
local tpm = tonumber(ARGV[3])
local rpd = tonumber(ARGV[4])
local conc = tonumber(ARGV[5])
local win = tonumber(ARGV[6])
local itpm = tonumber(ARGV[7])
local otpm = tonumber(ARGV[8])
local A = 8 -- op arguments start at ARGV[A + 1]
local DAY = 86400000

local s = redis.call('HMGET', KEYS[1], 'r', 't', 'd', 'ts', 'blk', 'i', 'o')
local r = tonumber(s[1]) or rpm
local tk = tonumber(s[2]) or tpm
local d = tonumber(s[3]) or rpd
local ts = tonumber(s[4]) or now
local blk = tonumber(s[5]) or 0
local ti = tonumber(s[6]) or itpm
local to = tonumber(s[7]) or otpm
local el = now - ts
if el < 0 then el = 0 end
if rpm > 0 then r = math.min(rpm, r + el * rpm / win) end
if tpm > 0 then tk = math.min(tpm, tk + el * tpm / win) end
if rpd > 0 then d = math.min(rpd, d + el * rpd / DAY) end
if itpm > 0 then ti = math.min(itpm, ti + el * itpm / win) end
if otpm > 0 then to = math.min(otpm, to + el * otpm / win) end

local inflight = 0
if conc > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
  inflight = redis.call('ZCARD', KEYS[2])
end

local function save()
  redis.call('HSET', KEYS[1], 'r', tostring(r), 't', tostring(tk), 'd', tostring(d), 'ts', now, 'blk', blk, 'i', tostring(ti), 'o', tostring(to))
  local ttl = win * 10
  if rpd > 0 then ttl = DAY * 2 end
  if blk - now + win > ttl then ttl = blk - now + win end
  redis.call('PEXPIRE', KEYS[1], math.ceil(ttl))
end

local function reply(ok, wait, reason)
  return { ok, math.ceil(wait), math.floor(r), math.floor(tk), math.floor(d), inflight, reason, math.floor(ti), math.floor(to) }
end

if op == 'acquire' then
  local cost = tonumber(ARGV[A + 1])
  local leaseId = ARGV[A + 2]
  local leaseTtl = tonumber(ARGV[A + 3])
  local costIn = tonumber(ARGV[A + 4]) or 0
  local costOut = tonumber(ARGV[A + 5]) or 0
  if (tpm > 0 and cost > tpm) or (itpm > 0 and costIn > itpm) or (otpm > 0 and costOut > otpm) then
    return reply(-1, 0, 'too_large')
  end
  local wait = 0
  local reason = ''
  if blk > now then wait = blk - now; reason = 'penalty' end
  if rpm > 0 and r < 1 then
    local w = (1 - r) * win / rpm
    if w > wait then wait = w; reason = 'rpm' end
  end
  if tpm > 0 and tk < cost then
    local w = (cost - tk) * win / tpm
    if w > wait then wait = w; reason = 'tpm' end
  end
  if rpd > 0 and d < 1 then
    local w = (1 - d) * DAY / rpd
    if w > wait then wait = w; reason = 'rpd' end
  end
  if itpm > 0 and ti < costIn then
    local w = (costIn - ti) * win / itpm
    if w > wait then wait = w; reason = 'itpm' end
  end
  if otpm > 0 and to < costOut then
    local w = (costOut - to) * win / otpm
    if w > wait then wait = w; reason = 'otpm' end
  end
  if conc > 0 and inflight >= conc then
    local first = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
    local w = 25
    if first[2] then w = math.max(1, math.min(tonumber(first[2]) - now, 250)) end
    if w > wait then wait = w; reason = 'concurrency' end
  end
  if wait > 0 then
    save()
    return reply(0, wait, reason)
  end
  if rpm > 0 then r = r - 1 end
  if tpm > 0 then tk = tk - cost end
  if rpd > 0 then d = d - 1 end
  if itpm > 0 then ti = ti - costIn end
  if otpm > 0 then to = to - costOut end
  if conc > 0 then
    redis.call('ZADD', KEYS[2], now + leaseTtl, leaseId)
    redis.call('PEXPIRE', KEYS[2], leaseTtl + win)
    inflight = inflight + 1
  end
  save()
  return reply(1, 0, '')
end

if op == 'settle' then
  local leaseId = ARGV[A + 1]
  local estimated = tonumber(ARGV[A + 2])
  local actual = tonumber(ARGV[A + 3])
  local refundRequest = tonumber(ARGV[A + 4])
  local estIn = tonumber(ARGV[A + 5]) or 0
  local actIn = tonumber(ARGV[A + 6]) or -1
  local estOut = tonumber(ARGV[A + 7]) or 0
  local actOut = tonumber(ARGV[A + 8]) or -1
  if tpm > 0 and actual >= 0 then tk = math.min(tpm, tk + estimated - actual) end
  if itpm > 0 and actIn >= 0 then ti = math.min(itpm, ti + estIn - actIn) end
  if otpm > 0 and actOut >= 0 then to = math.min(otpm, to + estOut - actOut) end
  if refundRequest == 1 then
    if rpm > 0 then r = math.min(rpm, r + 1) end
    if rpd > 0 then d = math.min(rpd, d + 1) end
  end
  if conc > 0 then
    inflight = inflight - redis.call('ZREM', KEYS[2], leaseId)
  end
  save()
  return reply(1, 0, '')
end

if op == 'observe' then
  local remReq = tonumber(ARGV[A + 1])
  local remTok = tonumber(ARGV[A + 2])
  local remIn = tonumber(ARGV[A + 3]) or -1
  local remOut = tonumber(ARGV[A + 4]) or -1
  if rpm > 0 and remReq >= 0 and remReq < r then r = remReq end
  if tpm > 0 and remTok >= 0 and remTok < tk then tk = remTok end
  if itpm > 0 and remIn >= 0 and remIn < ti then ti = remIn end
  if otpm > 0 and remOut >= 0 and remOut < to then to = remOut end
  save()
  return reply(1, 0, '')
end

if op == 'penalize' then
  local ms = tonumber(ARGV[A + 1])
  if now + ms > blk then blk = now + ms end
  save()
  return reply(1, 0, '')
end

if op == 'reset' then
  redis.call('DEL', KEYS[1], KEYS[2])
  return { 1, 0, rpm, tpm, rpd, 0, '', itpm, otpm }
end

local wait = 0
if blk > now then wait = blk - now end
return reply(1, wait, '')
`;
