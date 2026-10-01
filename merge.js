'use strict';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function elementsHaveIds(arr) {
  if (!Array.isArray(arr)) return true;
  return arr.every((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id);
}

function sameRelativeOrder(baseIds, ids) {
  const baseSet = new Set(baseIds);
  const filtered = ids.filter((id) => baseSet.has(id));
  const baseFiltered = baseIds.filter((id) => ids.includes(id));
  if (filtered.length !== baseFiltered.length) return false;
  return filtered.every((id, index) => id === baseFiltered[index]);
}

function mergeStringArray(base, server, client) {
  const baseArr = Array.isArray(base) ? base : [];
  const serverArr = Array.isArray(server) ? server : [];
  const clientArr = Array.isArray(client) ? client : [];
  const serverSet = new Set(serverArr);
  const clientSet = new Set(clientArr);
  const deleted = new Set();
  for (const item of baseArr) {
    if (!serverSet.has(item) || !clientSet.has(item)) deleted.add(item);
  }
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (seen.has(item) || deleted.has(item)) return;
    seen.add(item);
    out.push(item);
  };
  for (const item of baseArr) push(item);
  for (const item of serverArr) push(item);
  for (const item of clientArr) push(item);
  return out;
}

function mergeById(base, server, client) {
  const baseArr = Array.isArray(base) ? base : [];
  const baseMap = new Map(baseArr.filter((item) => item && item.id).map((item) => [item.id, item]));
  const serverMap = new Map(server.filter((item) => item && item.id).map((item) => [item.id, item]));
  const clientMap = new Map(client.filter((item) => item && item.id).map((item) => [item.id, item]));
  const baseIds = baseArr.map((item) => item && item.id).filter(Boolean);
  const clientIds = client.map((item) => item && item.id).filter(Boolean);
  const serverIds = server.map((item) => item && item.id).filter(Boolean);
  const clientReordered = !sameRelativeOrder(baseIds, clientIds);
  const primary = clientReordered ? clientIds : serverIds;
  const secondary = clientReordered ? serverIds : clientIds;
  const seen = new Set();
  const ids = [];
  for (const id of [...primary, ...secondary]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const out = [];
  for (const id of ids) {
    const baseItem = baseMap.get(id);
    const serverItem = serverMap.get(id);
    const clientItem = clientMap.get(id);
    if (serverItem && clientItem) {
      out.push(mergeValue(baseItem, serverItem, clientItem));
    } else if (clientItem && !serverItem) {
      if (!baseItem || !deepEqual(baseItem, clientItem)) out.push(clone(clientItem));
    } else if (serverItem && !clientItem) {
      if (!baseItem || !deepEqual(baseItem, serverItem)) out.push(clone(serverItem));
    }
  }
  return out;
}

function mergeArrayByIndex(base, server, client) {
  const baseArr = Array.isArray(base) ? base : [];
  const sharedLen = baseArr.length;
  const out = [];

  for (let i = 0; i < sharedLen; i += 1) {
    const baseItem = baseArr[i];
    const serverItem = server[i];
    const clientItem = client[i];
    if (clientItem === undefined && serverItem === undefined) continue;
    if (clientItem === undefined) {
      if (serverItem !== undefined && !deepEqual(baseItem, serverItem)) out.push(clone(serverItem));
      continue;
    }
    if (serverItem === undefined) {
      if (!deepEqual(baseItem, clientItem)) out.push(clone(clientItem));
      continue;
    }
    out.push(mergeValue(baseItem, serverItem, clientItem));
  }

  const serverAdds = server.slice(sharedLen);
  const clientAdds = client.slice(sharedLen);
  out.push(...serverAdds.map((item) => clone(item)));
  for (const item of clientAdds) {
    if (!serverAdds.some((serverItem) => deepEqual(serverItem, item))) out.push(clone(item));
  }
  return out;
}

function mergeObjects(base, server, client) {
  const baseObj = isPlainObject(base) ? base : {};
  const keys = new Set([
    ...Object.keys(baseObj),
    ...Object.keys(server),
    ...Object.keys(client)
  ]);
  const out = {};
  for (const key of keys) {
    const hasBase = Object.prototype.hasOwnProperty.call(baseObj, key);
    const hasServer = Object.prototype.hasOwnProperty.call(server, key);
    const hasClient = Object.prototype.hasOwnProperty.call(client, key);
    if (hasServer && hasClient) {
      out[key] = mergeValue(hasBase ? baseObj[key] : undefined, server[key], client[key]);
    } else if (hasClient && !hasServer) {
      if (!hasBase || !deepEqual(baseObj[key], client[key])) out[key] = clone(client[key]);
    } else if (hasServer && !hasClient) {
      if (!hasBase || !deepEqual(baseObj[key], server[key])) out[key] = clone(server[key]);
    }
  }
  return out;
}

function mergeValue(base, server, client) {
  if (deepEqual(server, client)) return clone(server);
  if (deepEqual(base, server)) return clone(client);
  if (deepEqual(base, client)) return clone(server);

  if (isPlainObject(server) && isPlainObject(client) && (base == null || isPlainObject(base))) {
    return mergeObjects(base, server, client);
  }

  if (Array.isArray(server) && Array.isArray(client) && (base == null || Array.isArray(base))) {
    if (isStringArray(server) && isStringArray(client) && (base == null || isStringArray(base))) {
      return mergeStringArray(base, server, client);
    }
    if (elementsHaveIds(base) && elementsHaveIds(server) && elementsHaveIds(client)) {
      return mergeById(base, server, client);
    }
    return mergeArrayByIndex(base, server, client);
  }

  return clone(client);
}

function mergeState(base, server, client) {
  return mergeValue(base, server, client);
}

module.exports = {
  deepEqual,
  mergeState
};
