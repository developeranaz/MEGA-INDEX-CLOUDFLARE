// this is an ultimate beta version to download nested folders and files inside files
// experimentewd like to augment files served like a zip packet 
// posted only for backup, incase this version of gets ............
const publicTreeCache = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      const pubFolderMatch = url.pathname.match(/^\/p\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/?$/);
      if (pubFolderMatch) {
        const folderHandle = pubFolderMatch[1];
        const keyB64 = pubFolderMatch[2];
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const tree = await getOrFetchPublicTree(folderHandle, keyB64, forceRefresh);
        const sub = url.searchParams.get("sub") || tree.rootHash;
        return renderUI(tree, sub, url.origin, {
          basePath: `/p/${folderHandle}/${keyB64}`,
          title: "Public MEGA Folder",
          subtitle: "Browsing a public mega.nz shared folder"
        });
      }

      const pubDownloadMatch = url.pathname.match(/^\/p\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/download\/([a-zA-Z0-9_-]+)$/);
      if (pubDownloadMatch) {
        const [, folderHandle, keyB64, nodeHash] = pubDownloadMatch;
        return await handlePublicFolderDownload(request, folderHandle, keyB64, nodeHash);
      }

      const pubZipMatch = url.pathname.match(/^\/p\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/zip\/?$/);
      if (pubZipMatch) {
        const [, folderHandle, keyB64] = pubZipMatch;
        return await handlePublicFolderZip(url, folderHandle, keyB64);
      }

      const pubFileDownloadMatch = url.pathname.match(/^\/pf\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/download$/);
      if (pubFileDownloadMatch) {
        const [, fileHandle, keyB64] = pubFileDownloadMatch;
        return await handlePublicFileDownload(request, fileHandle, keyB64);
      }

      const pubFileMatch = url.pathname.match(/^\/pf\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/?$/);
      if (pubFileMatch) {
        const [, fileHandle, keyB64] = pubFileMatch;
        const meta = await fetchPublicFileMeta(fileHandle, keyB64);
        return renderFileUI(meta, `/pf/${fileHandle}/${keyB64}`);
      }

      if (url.pathname === "/open") {
        const link = url.searchParams.get("link") || "";
        const parsed = parseMegaPublicLink(link);
        if (!parsed) {
          return new Response("Invalid MEGA public link. Expected formats: https://mega.nz/folder/HANDLE#KEY or https://mega.nz/file/HANDLE#KEY (old #F!h!k / #!h!k also supported).", { status: 400 });
        }
        const dest = parsed.type === "folder"
          ? `/p/${parsed.handle}/${parsed.key}`
          : `/pf/${parsed.handle}/${parsed.key}`;
        return Response.redirect(url.origin + dest, 302);
      }

      if (url.pathname === "/") {
        return renderLanding();
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(`Error: ${err.message}\n${err.stack}`, { status: 500 });
    }
  }
};

function parseMegaPublicLink(link) {
  try {
    link = link.trim();
    let m = link.match(/mega(?:\.co)?\.nz\/(folder|file)\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/);
    if (m) {
      return { type: m[1], handle: m[2], key: m[3] };
    }
    m = link.match(/mega(?:\.co)?\.nz\/#F!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
    if (m) {
      return { type: "folder", handle: m[1], key: m[2] };
    }
    m = link.match(/mega(?:\.co)?\.nz\/#!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
    if (m) {
      return { type: "file", handle: m[1], key: m[2] };
    }
    return null;
  } catch {
    return null;
  }
}

async function getOrFetchPublicTree(folderHandle, keyB64, forceRefresh) {
  const now = Date.now();
  const cached = publicTreeCache[folderHandle];
  if (cached && !forceRefresh && (now - cached.time < 5 * 60 * 1000)) {
    return cached.tree;
  }
  const tree = await fetchPublicTree(folderHandle, keyB64);
  publicTreeCache[folderHandle] = { tree, time: now };
  return tree;
}

async function fetchPublicTree(folderHandle, keyB64) {
  const shareKey = decodeBase64(keyB64);
  if (shareKey.length !== 16) {
    throw new Error("Invalid public folder key (must decode to 16 bytes).");
  }
  const sn = Math.floor(Math.random() * 2147483647);
  const response = await fetch(`https://g.api.mega.co.nz/cs?id=${sn}&n=${folderHandle}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ a: "f", c: 1, r: 1, ca: 1 }])
  });
  if (!response.ok) {
    throw new Error(`MEGA API fetch failed: ${response.status}`);
  }
  const data = await response.json();
  if (typeof data === "number" || typeof data[0] === "number") {
    throw new Error(`MEGA API error code: ${JSON.stringify(data)} (link may be invalid, removed, or taken down).`);
  }
  const rawNodes = data[0].f || [];

  const decryptedNodes = {};
  for (const rawNode of rawNodes) {
    if (rawNode.t !== 0 && rawNode.t !== 1) continue;
    const node = await decryptPublicNode(rawNode, shareKey);
    if (node) {
      node.children = [];
      decryptedNodes[node.hash] = node;
    }
  }
  let rootNodeHash = null;
  for (const hash in decryptedNodes) {
    const node = decryptedNodes[hash];
    if (node.parent && decryptedNodes[node.parent]) {
      decryptedNodes[node.parent].children.push(node);
    } else if (rootNodeHash === null || node.type === 1) {
      if (!decryptedNodes[node.parent]) {
        if (rootNodeHash === null) rootNodeHash = node.hash;
      }
    }
  }
  if (decryptedNodes[folderHandle]) {
    rootNodeHash = folderHandle;
  } else {
    for (const hash in decryptedNodes) {
      const node = decryptedNodes[hash];
      if (node.type === 1 && !decryptedNodes[node.parent]) {
        rootNodeHash = node.hash;
        break;
      }
    }
  }
  if (!rootNodeHash) {
    throw new Error("Could not determine root of public folder.");
  }

  return {
    nodes: decryptedNodes,
    rootHash: rootNodeHash
  };
}

async function decryptPublicNode(itm, shareKey) {
  try {
    const parts = itm.k.split(":");
    if (parts.length < 2) return null;
    const itemKeyBase64 = parts[1].split("/")[0];
    const encryptedKeyBytes = decodeBase64(itemKeyBase64);
    const decryptedKeyBytes = decryptAesEcbJS(shareKey, encryptedKeyBytes);

    let key;
    let iv = null;
    if (itm.t === 0) {
      key = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        key[i] = decryptedKeyBytes[i] ^ decryptedKeyBytes[i + 16];
      }
      iv = new Uint8Array(16);
      iv.set(decryptedKeyBytes.subarray(16, 24), 0);
    } else {
      key = decryptedKeyBytes;
    }

    const attr = await decryptAttr(key, itm.a);
    return {
      hash: itm.h,
      parent: itm.p,
      type: itm.t,
      name: attr.n,
      size: itm.s || 0,
      ts: itm.ts,
      key: key,
      iv: iv
    };
  } catch (err) {
    return null;
  }
}

async function handlePublicFolderDownload(request, folderHandle, keyB64, nodeHash) {
  const tree = await getOrFetchPublicTree(folderHandle, keyB64, false);
  const node = tree.nodes[nodeHash];
  if (!node || node.type !== 0) {
    return new Response("File Not Found", { status: 404 });
  }
  const sn = Math.floor(Math.random() * 2147483647);
  const apiRes = await fetch(`https://g.api.mega.co.nz/cs?id=${sn}&n=${folderHandle}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ a: "g", g: 1, n: nodeHash }])
  });
  if (!apiRes.ok) {
    throw new Error(`MEGA API Error fetching download link: ${apiRes.status}`);
  }
  const apiData = await apiRes.json();
  if (!apiData[0] || !apiData[0].g) {
    throw new Error("Failed to retrieve file download link from MEGA.");
  }
  return streamMegaFile(request, {
    size: node.size || 0,
    name: node.name,
    key: node.key,
    iv: node.iv
  }, apiData[0].g);
}

async function handlePublicFileDownload(request, fileHandle, keyB64) {
  const keyBytes = decodeBase64(keyB64);
  if (keyBytes.length !== 32) {
    throw new Error("Invalid public file key (must decode to 32 bytes).");
  }
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[i] = keyBytes[i] ^ keyBytes[i + 16];
  }
  const iv = new Uint8Array(16);
  iv.set(keyBytes.subarray(16, 24), 0);

  const sn = Math.floor(Math.random() * 2147483647);
  const apiRes = await fetch(`https://g.api.mega.co.nz/cs?id=${sn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ a: "g", g: 1, p: fileHandle }])
  });
  if (!apiRes.ok) {
    throw new Error(`MEGA API Error fetching download link: ${apiRes.status}`);
  }
  const apiData = await apiRes.json();
  if (typeof apiData === "number" || typeof apiData[0] === "number") {
    throw new Error(`MEGA API error code: ${JSON.stringify(apiData)} (link may be invalid, removed, or taken down).`);
  }
  if (!apiData[0] || !apiData[0].g) {
    throw new Error("Failed to retrieve file download link from MEGA.");
  }

  let name = "download.bin";
  try {
    const attr = await decryptAttr(key, apiData[0].at);
    if (attr && attr.n) name = attr.n;
  } catch {}

  return streamMegaFile(request, {
    size: apiData[0].s || 0,
    name,
    key,
    iv
  }, apiData[0].g);
}

async function fetchPublicFileMeta(fileHandle, keyB64) {
  const keyBytes = decodeBase64(keyB64);
  if (keyBytes.length !== 32) {
    throw new Error("Invalid public file key (must decode to 32 bytes).");
  }
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[i] = keyBytes[i] ^ keyBytes[i + 16];
  }

  const sn = Math.floor(Math.random() * 2147483647);
  const apiRes = await fetch(`https://g.api.mega.co.nz/cs?id=${sn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ a: "g", p: fileHandle }])
  });
  if (!apiRes.ok) {
    throw new Error(`MEGA API Error fetching file info: ${apiRes.status}`);
  }
  const apiData = await apiRes.json();
  if (typeof apiData === "number" || typeof apiData[0] === "number") {
    throw new Error(`MEGA API error code: ${JSON.stringify(apiData)} (link may be invalid, removed, or taken down).`);
  }
  const info = apiData[0] || {};
  let name = "download.bin";
  try {
    const attr = await decryptAttr(key, info.at);
    if (attr && attr.n) name = attr.n;
  } catch {}
  return { name, size: info.s || 0 };
}

async function streamMegaFile(request, node, downloadUrl) {
  const fileSize = node.size || 0;
  const rangeHeader = request.headers.get("Range");
  let isRange = false;
  let rangeStart = 0;
  let rangeEnd = fileSize - 1;

  if (rangeHeader && rangeHeader.startsWith("bytes=")) {
    const firstRange = rangeHeader.substring(6).split(",")[0].trim();
    const parts = firstRange.split("-");
    const startStr = parts[0].trim();
    const endStr = parts[1] ? parts[1].trim() : "";
    if (startStr !== "") {
      rangeStart = parseInt(startStr, 10);
      isRange = true;
      if (endStr !== "") {
        rangeEnd = parseInt(endStr, 10);
      }
    } else if (endStr !== "") {
      const suffixLen = parseInt(endStr, 10);
      rangeStart = fileSize - suffixLen;
      isRange = true;
    }
  }

  if (isRange && (rangeStart < 0 || rangeStart >= fileSize || rangeEnd < rangeStart)) {
    return new Response("Requested Range Not Satisfiable", {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes"
      }
    });
  }
  if (rangeEnd >= fileSize) {
    rangeEnd = fileSize - 1;
  }

  const aesStart = isRange ? Math.floor(rangeStart / 16) * 16 : 0;
  let discardBytes = isRange ? rangeStart - aesStart : 0;

  const cryptoKey = await crypto.subtle.importKey(
    "raw", node.key, { name: "AES-CTR" }, false, ["decrypt"]
  );

  const expectedSize = rangeEnd - rangeStart + 1;
  const CHUNK = 32 * 1024 * 1024;
  let pos = aesStart;
  const end = rangeEnd;

  const stream = new ReadableStream({
    async pull(controller) {
      if (pos > end) {
        controller.close();
        return;
      }
      const chunkEnd = Math.min(pos + CHUNK - 1, end);
      try {
        const chunkRes = await fetch(downloadUrl, {
          headers: { "Range": `bytes=${pos}-${chunkEnd}` }
        });
        if (!chunkRes.ok && chunkRes.status !== 206) {
          controller.error(new Error(`MEGA storage fetch failed: ${chunkRes.status}`));
          return;
        }
        const encrypted = new Uint8Array(await chunkRes.arrayBuffer());
        const iv = getCtrIv(node.iv, pos);
        let decrypted = new Uint8Array(await crypto.subtle.decrypt(
          { name: "AES-CTR", counter: iv, length: 64 },
          cryptoKey,
          encrypted
        ));
        if (discardBytes > 0) {
          decrypted = decrypted.slice(discardBytes);
          discardBytes = 0;
        }
        controller.enqueue(decrypted);
        pos = chunkEnd + 1;
      } catch (err) {
        controller.error(err);
      }
    }
  });

  const { readable, writable } = new FixedLengthStream(expectedSize);
  stream.pipeTo(writable).catch(() => {});

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(node.name)}"`,
    "Accept-Ranges": "bytes",
    "Content-Length": expectedSize.toString()
  });
  let status = 200;
  if (isRange) {
    status = 206;
    headers.set("Content-Range", `bytes ${rangeStart}-${rangeEnd}/${fileSize}`);
  }
  return new Response(readable, { status, headers });
}

function getCtrIv(metaIv, chkStart) {
  const iv = new Uint8Array(16);
  iv.set(metaIv.subarray(0, 8), 0);
  const counter = BigInt(chkStart) / 16n;
  const view = new DataView(iv.buffer);
  view.setBigUint64(8, counter, false);
  return iv;
}

const S = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15, 0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75, 0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf, 0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73, 0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08, 0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a, 0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e, 0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf, 0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16];
const Si = [0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb, 0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb, 0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e, 0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25, 0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92, 0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84, 0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06, 0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b, 0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73, 0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e, 0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b, 0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4, 0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f, 0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef, 0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61, 0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d];
const T5 = [0x51f4a750, 0x7e416553, 0x1a17a4c3, 0x3a275e96, 0x3bab6bcb, 0x1f9d45f1, 0xacfa58ab, 0x4be30393, 0x2030fa55, 0xad766df6, 0x88cc7691, 0xf5024c25, 0x4fe5d7fc, 0xc52acbd7, 0x26354480, 0xb562a38f, 0xdeb15a49, 0x25ba1b67, 0x45ea0e98, 0x5dfec0e1, 0xc32f7502, 0x814cf012, 0x8d4697a3, 0x6bd3f9c6, 0x038f5fe7, 0x15929c95, 0xbf6d7aeb, 0x955259da, 0xd4be832d, 0x587421d3, 0x49e06929, 0x8ec9c844, 0x75c2896a, 0xf48e7978, 0x99583e6b, 0x27b971dd, 0xbee14fb6, 0xf088ad17, 0xc920ac66, 0x7dce3ab4, 0x63df4a18, 0xe51a3182, 0x97513360, 0x62537f45, 0xb16477e0, 0xbb6bae84, 0xfe81a01c, 0xf9082b94, 0x70486858, 0x8f45fd19, 0x94de6c87, 0x527bf8b7, 0xab73d323, 0x724b02e2, 0xe31f8f57, 0x6655ab2a, 0xb2eb2807, 0x2fb5c203, 0x86c57b9a, 0xd33708a5, 0x302887f2, 0x23bfa5b2, 0x02036aba, 0xed16825c, 0x8acf1c2b, 0xa779b492, 0xf307f2f0, 0x4e69e2a1, 0x65daf4cd, 0x0605bed5, 0xd134621f, 0xc4a6fe8a, 0x342e539d, 0xa2f355a0, 0x058ae132, 0xa4f6eb75, 0x0b83ec39, 0x4060efaa, 0x5e719f06, 0xbd6e1051, 0x3e218af9, 0x96dd063d, 0xdd3e05ae, 0x4de6bd46, 0x91548db5, 0x71c45d05, 0x0406d46f, 0x605015ff, 0x1998fb24, 0xd6bde997, 0x894043cc, 0x67d99e77, 0xb0e842bd, 0x07898b88, 0xe7195b38, 0x79c8eedb, 0xa17c0a47, 0x7c420fe9, 0xf8841ec9, 0x00000000, 0x09808683, 0x322bed48, 0x1e1170ac, 0x6c5a724e, 0xfd0efffb, 0x0f853856, 0x3daed51e, 0x362d3927, 0x0a0fd964, 0x685ca621, 0x9b5b54d1, 0x24362e3a, 0x0c0a67b1, 0x9357e70f, 0xb4ee96d2, 0x1b9b919e, 0x80c0c54f, 0x61dc20a2, 0x5a774b69, 0x1c121a16, 0xe293ba0a, 0xc0a02ae5, 0x3c22e043, 0x121b171d, 0x0e090d0b, 0xf28bc7ad, 0x2db6a8b9, 0x141ea9c8, 0x57f11985, 0xaf75074c, 0xee99ddbb, 0xa37f60fd, 0xf701269f, 0x5c72f5bc, 0x44663bc5, 0x5bfb7e34, 0x8b432976, 0xcb23c6dc, 0xb6edfc68, 0xb8e4f163, 0xd731dcca, 0x42638510, 0x13972240, 0x84c61120, 0x854a247d, 0xd2bb3df8, 0xaef93211, 0xc729a16d, 0x1d9e2f4b, 0xdcb230f3, 0x0d8652ec, 0x77c1e3d0, 0x2bb3166c, 0xa970b999, 0x119448fa, 0x47e96422, 0xa8fc8cc4, 0xa0f03f1a, 0x567d2cd8, 0x223390ef, 0x87494ec7, 0xd938d1c1, 0x8ccaa2fe, 0x98d40b36, 0xa6f581cf, 0xa57ade28, 0xdab78e26, 0x3fadbfa4, 0x2c3a9de4, 0x5078920d, 0x6a5fcc9b, 0x547e4662, 0xf68d13c2, 0x90d8b8e8, 0x2e39f75e, 0x82c3aff5, 0x9f5d80be, 0x69d0937c, 0x6fd52da9, 0xcf2512b3, 0xc8ac993b, 0x10187da7, 0xe89c636e, 0xdb3bbb7b, 0xcd267809, 0x6e5918f4, 0xec9ab701, 0x834f9aa8, 0xe6956e65, 0xaaffe67e, 0x21bccf08, 0xef15e8e6, 0xbae79bd9, 0x4a6f36ce, 0xea9f09d4, 0x29b07cd6, 0x31a4b2af, 0x2a3f2331, 0xc6a59430, 0x35a266c0, 0x744ebc37, 0xfc82caa6, 0xe090d0b0, 0x33a7d815, 0xf104984a, 0x41ecdaf7, 0x7fcd500e, 0x1791f62f, 0x764dd68d, 0x43efb04d, 0xccaa4d54, 0xe49604df, 0x9ed1b5e3, 0x4c6a881b, 0xc12c1fb8, 0x4665517f, 0x9d5eea04, 0x018c355d, 0xfa877473, 0xfb0b412e, 0xb3671d5a, 0x92dbd252, 0xe9105633, 0x6dd64713, 0x9ad7618c, 0x37a10c7a, 0x59f8148e, 0xeb133c89, 0xcea927ee, 0xb761c935, 0xe11ce5ed, 0x7a47b13c, 0x9cd2df59, 0x55f2733f, 0x1814ce79, 0x73c737bf, 0x53f7cdea, 0x5ffdaa5b, 0xdf3d6f14, 0x7844db86, 0xcaaff381, 0xb968c43e, 0x3824342c, 0xc2a3405f, 0x161dc372, 0xbce2250c, 0x283c498b, 0xff0d9541, 0x39a80171, 0x080cb3de, 0xd8b4e49c, 0x6456c190, 0x7bcb8461, 0xd532b670, 0x486c5c74, 0xd0b85742];
const T6 = [0x5051f4a7, 0x537e4165, 0xc31a17a4, 0x963a275e, 0xcb3bab6b, 0xf11f9d45, 0xabacfa58, 0x934be303, 0x552030fa, 0xf6ad766d, 0x9188cc76, 0x25f5024c, 0xfc4fe5d7, 0xd7c52acb, 0x80263544, 0x8fb562a3, 0x49deb15a, 0x6725ba1b, 0x9845ea0e, 0xe15dfec0, 0x02c32f75, 0x12814cf0, 0xa38d4697, 0xc66bd3f9, 0xe7038f5f, 0x9515929c, 0xebbf6d7a, 0xda955259, 0x2dd4be83, 0xd3587421, 0x2949e069, 0x448ec9c8, 0x6a75c289, 0x78f48e79, 0x6b99583e, 0xdd27b971, 0xb6bee14f, 0x17f088ad, 0x66c920ac, 0xb47dce3a, 0x1863df4a, 0x82e51a31, 0x60975133, 0x4562537f, 0xe0b16477, 0x84bb6bae, 0x1cfe81a0, 0x94f9082b, 0x58704868, 0x198f45fd, 0x8794de6c, 0xb7527bf8, 0x23ab73d3, 0xe2724b02, 0x57e31f8f, 0x2a6655ab, 0x07b2eb28, 0x032fb5c2, 0x9a86c57b, 0xa5d33708, 0xf2302887, 0xb223bfa5, 0xba02036a, 0x5ced1682, 0x2b8acf1c, 0x92a779b4, 0xf0f307f2, 0xa14e69e2, 0xcd65daf4, 0xd50605be, 0x1fd13462, 0x8ac4a6fe, 0x9d342e53, 0xa0a2f355, 0x32058ae1, 0x75a4f6eb, 0x390b83ec, 0xaa4060ef, 0x065e719f, 0x51bd6e10, 0xf93e218a, 0x3d96dd06, 0xaedd3e05, 0x464de6bd, 0xb591548d, 0x0571c45d, 0x6f0406d4, 0xff605015, 0x241998fb, 0x97d6bde9, 0xcc894043, 0x7767d99e, 0xbdb0e842, 0x8807898b, 0x38e7195b, 0xdb79c8ee, 0x47a17c0a, 0xe97c420f, 0xc9f8841e, 0x00000000, 0x83098086, 0x48322bed, 0xac1e1170, 0x4e6c5a72, 0xfbfd0eff, 0x560f8538, 0x1e3daed5, 0x27362d39, 0x640a0fd9, 0x21685ca6, 0xd19b5b54, 0x3a24362e, 0xb10c0a67, 0x0f9357e7, 0xd2b4ee96, 0x9e1b9b91, 0x4f80c0c5, 0xa261dc20, 0x695a774b, 0x161c121a, 0x0ae293ba, 0xe5c0a02a, 0x433c22e0, 0x1d121b17, 0x0b0e090d, 0xadf28bc7, 0xb92db6a8, 0xc8141ea9, 0x8557f119, 0x4caf7507, 0xbbee99dd, 0xfda37f60, 0x9ff70126, 0xbc5c72f5, 0xc544663b, 0x345bfb7e, 0x768b4329, 0xdccb23c6, 0x68b6edfc, 0x63b8e4f1, 0xcad731dc, 0x10426385, 0x40139722, 0x2084c611, 0x7d854a24, 0xf8d2bb3d, 0x11aef932, 0x6dc729a1, 0x4b1d9e2f, 0xf3dcb230, 0xec0d8652, 0xd077c1e3, 0x6c2bb316, 0x99a970b9, 0xfa119448, 0x2247e964, 0xc4a8fc8c, 0x1aa0f03f, 0xd8567d2c, 0xef223390, 0xc787494e, 0xc1d938d1, 0xfe8ccaa2, 0x3698d40b, 0xcfa6f581, 0x28a57ade, 0x26dab78e, 0xa43fadbf, 0xe42c3a9d, 0x0d507892, 0x9b6a5fcc, 0x62547e46, 0xc2f68d13, 0xe890d8b8, 0x5e2e39f7, 0xf582c3af, 0xbe9f5d80, 0x7c69d093, 0xa96fd52d, 0xb3cf2512, 0x3bc8ac99, 0xa710187d, 0x6ee89c63, 0x7bdb3bbb, 0x09cd2678, 0xf46e5918, 0x01ec9ab7, 0xa8834f9a, 0x65e6956e, 0x7eaaffe6, 0x0821bccf, 0xe6ef15e8, 0xd9bae79b, 0xce4a6f36, 0xd4ea9f09, 0xd629b07c, 0xaf31a4b2, 0x312a3f23, 0x30c6a594, 0xc035a266, 0x37744ebc, 0xa6fc82ca, 0xb0e090d0, 0x1533a7d8, 0x4af10498, 0xf741ecda, 0x0e7fcd50, 0x2f1791f6, 0x8d764dd6, 0x4d43efb0, 0x54ccaa4d, 0xdfe49604, 0xe39ed1b5, 0x1b4c6a88, 0xb8c12c1f, 0x7f466551, 0x049d5eea, 0x5d018c35, 0x73fa8774, 0x2efb0b41, 0x5ab3671d, 0x5292dbd2, 0x33e91056, 0x136dd647, 0x8c9ad761, 0x7a37a10c, 0x8e59f814, 0x89eb133c, 0xeecea927, 0x35b761c9, 0xede11ce5, 0x3c7a47b1, 0x599cd2df, 0x3f55f273, 0x791814ce, 0xbf73c737, 0xea53f7cd, 0x5b5ffdaa, 0x14df3d6f, 0x867844db, 0x81caaff3, 0x3eb968c4, 0x2c382434, 0x5fc2a340, 0x72161dc3, 0x0cbce225, 0x8b283c49, 0x41ff0d95, 0x7139a801, 0xde080cb3, 0x9cd8b4e4, 0x906456c1, 0x617bcb84, 0x70d532b6, 0x74486c5c, 0x42d0b857];
const T7 = [0xa75051f4, 0x65537e41, 0xa4c31a17, 0x5e963a27, 0x6bcb3bab, 0x45f11f9d, 0x58abacfa, 0x03934be3, 0xfa552030, 0x6df6ad76, 0x769188cc, 0x4c25f502, 0xd7fc4fe5, 0xcbd7c52a, 0x44802635, 0xa38fb562, 0x5a49deb1, 0x1b6725ba, 0x0e9845ea, 0xc0e15dfe, 0x7502c32f, 0xf012814c, 0x97a38d46, 0xf9c66bd3, 0x5fe7038f, 0x9c951592, 0x7aebbf6d, 0x59da9552, 0x832dd4be, 0x21d35874, 0x692949e0, 0xc8448ec9, 0x896a75c2, 0x7978f48e, 0x3e6b9958, 0x71dd27b9, 0x4fb6bee1, 0xad17f088, 0xac66c920, 0x3ab47dce, 0x4a1863df, 0x3182e51a, 0x33609751, 0x7f456253, 0x77e0b164, 0xae84bb6b, 0xa01cfe81, 0x2b94f908, 0x68587048, 0xfd198f45, 0x6c8794de, 0xf8b7527b, 0xd323ab73, 0x02e2724b, 0x8f57e31f, 0xab2a6655, 0x2807b2eb, 0xc2032fb5, 0x7b9a86c5, 0x08a5d337, 0x87f23028, 0xa5b223bf, 0x6aba0203, 0x825ced16, 0x1c2b8acf, 0xb492a779, 0xf2f0f307, 0xe2a14e69, 0xf4cd65da, 0xbed50605, 0x621fd134, 0xfe8ac4a6, 0x539d342e, 0x55a0a2f3, 0xe132058a, 0xeb75a4f6, 0xec390b83, 0xefaa4060, 0x9f065e71, 0x1051bd6e, 0x8af93e21, 0x063d96dd, 0x05aedd3e, 0xbd464de6, 0x8db59154, 0x5d0571c4, 0xd46f0406, 0x15ff6050, 0xfb241998, 0xe997d6bd, 0x43cc8940, 0x9e7767d9, 0x42bdb0e8, 0x8b880789, 0x5b38e719, 0xeedb79c8, 0x0a47a17c, 0x0fe97c42, 0x1ec9f884, 0x00000000, 0x86830980, 0xed48322b, 0x70ac1e11, 0x724e6c5a, 0xfffbfd0e, 0x38560f85, 0xd51e3dae, 0x3927362d, 0xd9640a0f, 0xa621685c, 0x54d19b5b, 0x2e3a2436, 0x67b10c0a, 0xe70f9357, 0x96d2b4ee, 0x919e1b9b, 0xc54f80c0, 0x20a261dc, 0x4b695a77, 0x1a161c12, 0xba0ae293, 0x2ae5c0a0, 0xe0433c22, 0x171d121b, 0x0d0b0e09, 0xc7adf28b, 0xa8b92db6, 0xa9c8141e, 0x198557f1, 0x074caf75, 0xddbbee99, 0x60fda37f, 0x269ff701, 0xf5bc5c72, 0x3bc54466, 0x7e345bfb, 0x29768b43, 0xc6dccb23, 0xfc68b6ed, 0xf163b8e4, 0xdccad731, 0x85104263, 0x22401397, 0x112084c6, 0x247d854a, 0x3df8d2bb, 0x3211aef9, 0xa16dc729, 0x2f4b1d9e, 0x30f3dcb2, 0x52ec0d86, 0xe3d077c1, 0x166c2bb3, 0xb999a970, 0x48fa1194, 0x642247e9, 0x8cc4a8fc, 0x3f1aa0f0, 0x2cd8567d, 0x90ef2233, 0x4ec78749, 0xd1c1d938, 0xa2fe8cca, 0x0b3698d4, 0x81cfa6f5, 0xde28a57a, 0x8e26dab7, 0xbfa43fad, 0x9de42c3a, 0x920d5078, 0xcc9b6a5f, 0x4662547e, 0x13c2f68d, 0xb8e890d8, 0xf75e2e39, 0xaff582c3, 0x80be9f5d, 0x937c69d0, 0x2da96fd5, 0x12b3cf25, 0x993bc8ac, 0x7da71018, 0x636ee89c, 0xbb7bdb3b, 0x7809cd26, 0x18f46e59, 0xb701ec9a, 0x9aa8834f, 0x6e65e695, 0xe67eaaff, 0xcf0821bc, 0xe8e6ef15, 0x9bd9bae7, 0x36ce4a6f, 0x09d4ea9f, 0x7cd629b0, 0xb2af31a4, 0x23312a3f, 0x9430c6a5, 0x66c035a2, 0xbc37744e, 0xcaa6fc82, 0xd0b0e090, 0xd81533a7, 0x984af104, 0xdaf741ec, 0x500e7fcd, 0xf62f1791, 0xd68d764d, 0xb04d43ef, 0x4d54ccaa, 0x04dfe496, 0xb5e39ed1, 0x881b4c6a, 0x1fb8c12c, 0x517f4665, 0xea049d5e, 0x355d018c, 0x7473fa87, 0x412efb0b, 0x1d5ab367, 0xd25292db, 0x5633e910, 0x47136dd6, 0x618c9ad7, 0x0c7a37a1, 0x148e59f8, 0x3c89eb13, 0x27eecea9, 0xc935b761, 0xe5ede11c, 0xb13c7a47, 0xdf599cd2, 0x733f55f2, 0xce791814, 0x37bf73c7, 0xcdea53f7, 0xaa5b5ffd, 0x6f14df3d, 0xdb867844, 0xf381caaf, 0xc43eb968, 0x342c3824, 0x405fc2a3, 0xc372161d, 0x250cbce2, 0x498b283c, 0x9541ff0d, 0x017139a8, 0xb3de080c, 0xe49cd8b4, 0xc1906456, 0x84617bcb, 0xb670d532, 0x5c74486c, 0x5742d0b8];
const T8 = [0xf4a75051, 0x4165537e, 0x17a4c31a, 0x275e963a, 0xab6bcb3b, 0x9d45f11f, 0xfa58abac, 0xe303934b, 0x30fa5520, 0x766df6ad, 0xcc769188, 0x024c25f5, 0xe5d7fc4f, 0x2acbd7c5, 0x35448026, 0x62a38fb5, 0xb15a49de, 0xba1b6725, 0xea0e9845, 0xfec0e15d, 0x2f7502c3, 0x4cf01281, 0x4697a38d, 0xd3f9c66b, 0x8f5fe703, 0x929c9515, 0x6d7aebbf, 0x5259da95, 0xbe832dd4, 0x7421d358, 0xe0692949, 0xc9c8448e, 0xc2896a75, 0x8e7978f4, 0x583e6b99, 0xb971dd27, 0xe14fb6be, 0x88ad17f0, 0x20ac66c9, 0xce3ab47d, 0xdf4a1863, 0x1a3182e5, 0x51336097, 0x537f4562, 0x6477e0b1, 0x6bae84bb, 0x81a01cfe, 0x082b94f9, 0x48685870, 0x45fd198f, 0xde6c8794, 0x7bf8b752, 0x73d323ab, 0x4b02e272, 0x1f8f57e3, 0x55ab2a66, 0xeb2807b2, 0xb5c2032f, 0xc57b9a86, 0x3708a5d3, 0x2887f230, 0xbfa5b223, 0x036aba02, 0x16825ced, 0xcf1c2b8a, 0x79b492a7, 0x07f2f0f3, 0x69e2a14e, 0xdaf4cd65, 0x05bed506, 0x34621fd1, 0xa6fe8ac4, 0x2e539d34, 0xf355a0a2, 0x8ae13205, 0xf6eb75a4, 0x83ec390b, 0x60efaa40, 0x719f065e, 0x6e1051bd, 0x218af93e, 0xdd063d96, 0x3e05aedd, 0xe6bd464d, 0x548db591, 0xc45d0571, 0x06d46f04, 0x5015ff60, 0x98fb2419, 0xbde997d6, 0x4043cc89, 0xd99e7767, 0xe842bdb0, 0x898b8807, 0x195b38e7, 0xc8eedb79, 0x7c0a47a1, 0x420fe97c, 0x841ec9f8, 0x00000000, 0x80868309, 0x2bed4832, 0x1170ac1e, 0x5a724e6c, 0x0efffbfd, 0x8538560f, 0xaed51e3d, 0x2d392736, 0x0fd9640a, 0x5ca62168, 0x5b54d19b, 0x362e3a24, 0x0a67b10c, 0x57e70f93, 0xee96d2b4, 0x9b919e1b, 0xc0c54f80, 0xdc20a261, 0x774b695a, 0x121a161c, 0x93ba0ae2, 0xa02ae5c0, 0x22e0433c, 0x1b171d12, 0x090d0b0e, 0x8bc7adf2, 0xb6a8b92d, 0x1ea9c814, 0xf1198557, 0x75074caf, 0x99ddbbee, 0x7f60fda3, 0x01269ff7, 0x72f5bc5c, 0x663bc544, 0xfb7e345b, 0x4329768b, 0x23c6dccb, 0xedfc68b6, 0xe4f163b8, 0x31dccad7, 0x63851042, 0x97224013, 0xc6112084, 0x4a247d85, 0xbb3df8d2, 0xf93211ae, 0x29a16dc7, 0x9e2f4b1d, 0xb230f3dc, 0x8652ec0d, 0xc1e3d077, 0xb3166c2b, 0x70b999a9, 0x9448fa11, 0xe9642247, 0xfc8cc4a8, 0xf03f1aa0, 0x7d2cd856, 0x3390ef22, 0x494ec787, 0x38d1c1d9, 0xcaa2fe8c, 0xd40b3698, 0xf581cfa6, 0x7ade28a5, 0xb78e26da, 0xadbfa43f, 0x3a9de42c, 0x78920d50, 0x5fcc9b6a, 0x7e466254, 0x8d13c2f6, 0xd8b8e890, 0x39f75e2e, 0xc3aff582, 0x5d80be9f, 0xd0937c69, 0xd52da96f, 0x2512b3cf, 0xac993bc8, 0x187da710, 0x9c636ee8, 0x3bbb7bdb, 0x267809cd, 0x5918f46e, 0x9ab701ec, 0x4f9aa883, 0x956e65e6, 0xffe67eaa, 0xbccf0821, 0x15e8e6ef, 0xe79bd9ba, 0x6f36ce4a, 0x9f09d4ea, 0xb07cd629, 0xa4b2af31, 0x3f23312a, 0xa59430c6, 0xa266c035, 0x4ebc3774, 0x82caa6fc, 0x90d0b0e0, 0xa7d81533, 0x04984af1, 0xecdaf741, 0xcd500e7f, 0x91f62f17, 0x4dd68d76, 0xefb04d43, 0xaa4d54cc, 0x9604dfe4, 0xd1b5e39e, 0x6a881b4c, 0x2c1fb8c1, 0x65517f46, 0x5eea049d, 0x8c355d01, 0x877473fa, 0x0b412efb, 0x671d5ab3, 0xdbd25292, 0x105633e9, 0xd647136d, 0xd7618c9a, 0xa10c7a37, 0xf8148e59, 0x133c89eb, 0xa927eece, 0x61c935b7, 0x1ce5ede1, 0x47b13c7a, 0xd2df599c, 0xf2733f55, 0x14ce7918, 0xc737bf73, 0xf7cdea53, 0xfdaa5b5f, 0x3d6f14df, 0x44db8678, 0xaff381ca, 0x68c43eb9, 0x24342c38, 0xa3405fc2, 0x1dc37216, 0xe2250cbc, 0x3c498b28, 0x0d9541ff, 0xa8017139, 0x0cb3de08, 0xb4e49cd8, 0x56c19064, 0xcb84617b, 0x32b670d5, 0x6c5c7448, 0xb85742d0];

function convertToInt32(bytes) {
  var result = [];
  for (var i = 0; i < bytes.length; i += 4) {
    result.push(
      (bytes[i] << 24) |
      (bytes[i + 1] << 16) |
      (bytes[i + 2] << 8) |
      bytes[i + 3]
    );
  }
  return result;
}

var AES = function(key) {
  this.key = key;
  this._prepare();
}

AES.prototype._prepare = function() {
  var rounds = 10;
  this._Kd = [];
  for (var i = 0; i <= rounds; i++) {
    this._Kd.push([0, 0, 0, 0]);
  }
  var roundKeyCount = (rounds + 1) * 4;
  var KC = 4;
  var tk = convertToInt32(this.key);
  for (var i = 0; i < KC; i++) {
    var index = i >> 2;
    this._Kd[rounds - index][i % 4] = tk[i];
  }
  var rconpointer = 0;
  var t = KC, tt;
  var rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  while (t < roundKeyCount) {
    tt = tk[KC - 1];
    tk[0] ^= ((S[(tt >> 16) & 0xFF] << 24) ^
      (S[(tt >> 8) & 0xFF] << 16) ^
      (S[tt & 0xFF] << 8) ^
      S[(tt >> 24) & 0xFF] ^
      (rcon[rconpointer] << 24));
    rconpointer += 1;
    for (var i = 1; i < KC; i++) {
      tk[i] ^= tk[i - 1];
    }
    var destRound = (t >> 2);
    this._Kd[rounds - destRound][t % 4] = tk[0];
    this._Kd[rounds - destRound][(t + 1) % 4] = tk[1];
    this._Kd[rounds - destRound][(t + 2) % 4] = tk[2];
    this._Kd[rounds - destRound][(t + 3) % 4] = tk[3];
    t += 4;
  }
  var roundKey;
  for (var r = 1; r < rounds; r++) {
    roundKey = this._Kd[r];
    for (var i = 0; i < 4; i++) {
      tt = roundKey[i];
      roundKey[i] = (T5[S[(tt >> 24) & 0xFF]] ^
        T6[S[(tt >> 16) & 0xFF]] ^
        T7[S[(tt >> 8) & 0xFF]] ^
        T8[S[tt & 0xFF]]);
    }
  }
}

AES.prototype.decrypt = function(ciphertext) {
  var rounds = 10;
  var a = [0, 0, 0, 0];
  var t = convertToInt32(ciphertext);
  for (var i = 0; i < 4; i++) {
    t[i] ^= this._Kd[0][i];
  }
  for (var r = 1; r < rounds; r++) {
    for (var i = 0; i < 4; i++) {
      a[i] = (T5[(t[i] >> 24) & 0xff] ^
        T6[(t[(i + 3) % 4] >> 16) & 0xff] ^
        T7[(t[(i + 2) % 4] >> 8) & 0xff] ^
        T8[t[(i + 1) % 4] & 0xff] ^
        this._Kd[r][i]);
    }
    t = a.slice();
  }
  var result = new Uint8Array(16), tt;
  for (var i = 0; i < 4; i++) {
    tt = this._Kd[rounds][i];
    result[4 * i] = (Si[(t[i] >> 24) & 0xff] ^ (tt >> 24)) & 0xff;
    result[4 * i + 1] = (Si[(t[(i + 3) % 4] >> 16) & 0xff] ^ (tt >> 16)) & 0xff;
    result[4 * i + 2] = (Si[(t[(i + 2) % 4] >> 8) & 0xff] ^ (tt >> 8)) & 0xff;
    result[4 * i + 3] = (Si[t[(i + 1) % 4] & 0xff] ^ tt) & 0xff;
  }
  return result;
}

function decryptAesEcbJS(keyBytes, ciphertextBytes) {
  const aes = new AES(keyBytes);
  const result = new Uint8Array(ciphertextBytes.length);
  for (let i = 0; i < ciphertextBytes.length; i += 16) {
    const block = ciphertextBytes.subarray(i, i + 16);
    const decrypted = aes.decrypt(block);
    result.set(decrypted, i);
  }
  return result;
}

function decryptAesCbcJS(keyBytes, ciphertextBytes, iv) {
  const aes = new AES(keyBytes);
  const result = new Uint8Array(ciphertextBytes.length);
  let lastBlock = iv || new Uint8Array(16);
  for (let i = 0; i < ciphertextBytes.length; i += 16) {
    const block = ciphertextBytes.subarray(i, i + 16);
    const decrypted = aes.decrypt(block);
    for (let j = 0; j < 16; j++) {
      result[i + j] = decrypted[j] ^ lastBlock[j];
    }
    lastBlock = block;
  }
  return result;
}

async function decryptAttr(bkey, encryptedAttrB64) {
  const data = decodeBase64(encryptedAttrB64);
  const decrypted = decryptAesCbcJS(bkey, data, new Uint8Array(16));
  const bytes = new Uint8Array(decrypted);
  if (bytes[0] === 77 && bytes[1] === 69 && bytes[2] === 71 && bytes[3] === 65) {
    const decoder = new TextDecoder();
    let jsonStr = decoder.decode(bytes.subarray(4));
    jsonStr = jsonStr.replace(/\0/g, '');
    const startIdx = jsonStr.indexOf('{');
    const endIdx = jsonStr.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      jsonStr = jsonStr.substring(startIdx, endIdx + 1);
    }
    return JSON.parse(jsonStr);
  }
  throw new Error("Invalid attribute envelope signature");
}

function decodeBase64(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) {
    str += "=";
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}


const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function createCrc32() {
  let crc = 0xFFFFFFFF;
  return {
    update(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        crc = CRC_TABLE[(crc ^ chunk[i]) & 0xFF] ^ (crc >>> 8);
      }
    },
    digest() {
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
  };
}

function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xFFFF, true); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(Math.trunc(n)), true); return b; }
function concatBytes(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function toDosTime(unixSeconds) {
  const d = new Date((unixSeconds ? unixSeconds : Math.floor(Date.now() / 1000)) * 1000);
  const year = d.getFullYear();
  const dosYear = Math.max(0, year - 1980);
  const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const dosDate = ((dosYear & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
  return { dosTime, dosDate };
}

const ZIP64_THRESHOLD = 0xFFFFFFFE;

function buildLocalFileHeader(nameBytes, size, dosTime, dosDate, useZip64) {
  const sizeField = useZip64 ? 0xFFFFFFFF : size;
  const parts = [
    u32(0x04034b50),
    u16(useZip64 ? 45 : 20),
    u16(0x0808), // bit3: data descriptor follows | bit11: UTF-8 name
    u16(0),      // method 0 = store (no compression)
    u16(dosTime),
    u16(dosDate),
    u32(0),      // crc32 unknown yet
    u32(sizeField),
    u32(sizeField),
    u16(nameBytes.length),
    u16(useZip64 ? 20 : 0)
  ];
  parts.push(nameBytes);
  if (useZip64) {
    parts.push(u16(0x0001), u16(16), u64(size), u64(size));
  }
  return concatBytes(parts);
}

function buildDataDescriptor(crc, size, useZip64) {
  const parts = [u32(0x08074b50), u32(crc)];
  if (useZip64) {
    parts.push(u64(size), u64(size));
  } else {
    parts.push(u32(size), u32(size));
  }
  return concatBytes(parts);
}

function buildDirectoryLocalHeader(nameBytes, dosTime, dosDate) {
  return concatBytes([
    u32(0x04034b50),
    u16(20),
    u16(0x0800), // UTF-8 only; sizes/crc are known (0) so no data descriptor needed
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(0),
    u32(0),
    u32(0),
    u16(nameBytes.length),
    u16(0),
    nameBytes
  ]);
}

function buildCentralDirHeader(nameBytes, crc, size, offset, dosTime, dosDate, isDir, useZip64Size, useZip64Offset) {
  const useZip64 = useZip64Size || useZip64Offset;
  const sizeField = useZip64Size ? 0xFFFFFFFF : size;
  const offsetField = useZip64Offset ? 0xFFFFFFFF : offset;
  let extraBytes = new Uint8Array(0);
  if (useZip64) {
    const dataParts = [];
    if (useZip64Size) dataParts.push(u64(size), u64(size));
    if (useZip64Offset) dataParts.push(u64(offset));
    const dataBytes = concatBytes(dataParts);
    extraBytes = concatBytes([u16(0x0001), u16(dataBytes.length), dataBytes]);
  }
  const parts = [
    u32(0x02014b50),
    u16(0x031E),                // version made by (unix)
    u16(useZip64 ? 45 : 20),    // version needed
    u16(isDir ? 0x0800 : 0x0808),
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(sizeField),
    u32(sizeField),
    u16(nameBytes.length),
    u16(extraBytes.length),
    u16(0),
    u16(0),
    u16(0),
    u32(isDir ? (0x10 | (0o40755 << 16)) : (0o100644 << 16)),
    u32(offsetField)
  ];
  parts.push(nameBytes, extraBytes);
  return concatBytes(parts);
}

function buildEOCD(entryCount, cdSize, cdOffset, needZip64) {
  const chunks = [];
  if (needZip64) {
    const zip64EocdOffset = cdOffset + cdSize;
    chunks.push(concatBytes([
      u32(0x06064b50),
      u64(44),
      u16(45), u16(45),
      u32(0), u32(0),
      u64(entryCount), u64(entryCount),
      u64(cdSize), u64(cdOffset)
    ]));
    chunks.push(concatBytes([
      u32(0x07064b50),
      u32(0),
      u64(zip64EocdOffset),
      u32(1)
    ]));
  }
  const entryCount16 = needZip64 ? 0xFFFF : entryCount;
  const cdSize32 = needZip64 ? 0xFFFFFFFF : cdSize;
  const cdOffset32 = needZip64 ? 0xFFFFFFFF : cdOffset;
  chunks.push(concatBytes([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(entryCount16), u16(entryCount16),
    u32(cdSize32),
    u32(cdOffset32),
    u16(0)
  ]));
  return concatBytes(chunks);
}

function resolveSelectionToEntries(tree, selectedHashes) {
  const selectedSet = new Set(selectedHashes);
  const topLevel = [];
  const seenTop = new Set();

  for (const hash of selectedHashes) {
    const node = tree.nodes[hash];
    if (!node || seenTop.has(hash)) continue;

    let coveredByAncestor = false;
    let p = node.parent;
    while (p) {
      if (selectedSet.has(p)) { coveredByAncestor = true; break; }
      const pNode = tree.nodes[p];
      p = pNode ? pNode.parent : null;
    }
    if (!coveredByAncestor) {
      seenTop.add(hash);
      topLevel.push(node);
    }
  }

  const entries = [];
  function walk(node, basePath) {
    const path = basePath ? `${basePath}/${node.name}` : node.name;
    if (node.type === 1) {
      const children = (node.children || []).slice().sort((a, b) => {
        if (a.type !== b.type) return b.type - a.type;
        return a.name.localeCompare(b.name);
      });
      if (children.length === 0) {
        entries.push({ path: path + "/", node, isDir: true });
      } else {
        for (const child of children) walk(child, path);
      }
    } else {
      entries.push({ path, node, isDir: false });
    }
  }
  for (const node of topLevel) walk(node, "");
  return entries;
}

async function getPublicNodeDownloadUrl(folderHandle, nodeHash) {
  const sn = Math.floor(Math.random() * 2147483647);
  const apiRes = await fetch(`https://g.api.mega.co.nz/cs?id=${sn}&n=${folderHandle}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ a: "g", g: 1, n: nodeHash }])
  });
  if (!apiRes.ok) {
    throw new Error(`MEGA API Error fetching download link: ${apiRes.status}`);
  }
  const apiData = await apiRes.json();
  if (typeof apiData === "number" || typeof apiData[0] === "number") {
    throw new Error(`MEGA API error code: ${JSON.stringify(apiData)}`);
  }
  if (!apiData[0] || !apiData[0].g) {
    throw new Error("Failed to retrieve file download link from MEGA.");
  }
  return apiData[0].g;
}

async function* decryptedFileChunks(node, downloadUrl) {
  const fileSize = node.size || 0;
  if (fileSize === 0) return;
  const cryptoKey = await crypto.subtle.importKey(
    "raw", node.key, { name: "AES-CTR" }, false, ["decrypt"]
  );
  const CHUNK = 8 * 1024 * 1024; // smaller than the single-file path to bound
  let pos = 0;
  while (pos < fileSize) {
    const chunkEnd = Math.min(pos + CHUNK - 1, fileSize - 1);
    const res = await fetch(downloadUrl, { headers: { "Range": `bytes=${pos}-${chunkEnd}` } });
    if (!res.ok && res.status !== 206) {
      throw new Error(`MEGA storage fetch failed: ${res.status}`);
    }
    const encrypted = new Uint8Array(await res.arrayBuffer());
    const iv = getCtrIv(node.iv, pos);
    const decrypted = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: iv, length: 64 }, cryptoKey, encrypted
    ));
    yield decrypted;
    pos = chunkEnd + 1;
  }
}

async function* generateZipStream(tree, folderHandle, entries) {
  const encoder = new TextEncoder();
  const centralRecords = [];
  let offset = 0n;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const { dosTime, dosDate } = toDosTime(entry.node.ts);
    const localHeaderOffset = offset;

    if (entry.isDir) {
      const header = buildDirectoryLocalHeader(nameBytes, dosTime, dosDate);
      yield header;
      offset += BigInt(header.length);
      centralRecords.push({ nameBytes, crc: 0, size: 0, offset: localHeaderOffset, dosTime, dosDate, isDir: true });
      continue;
    }

    const size = entry.node.size || 0;
    const useZip64 = size > ZIP64_THRESHOLD;
    const header = buildLocalFileHeader(nameBytes, size, dosTime, dosDate, useZip64);
    yield header;
    offset += BigInt(header.length);

    const crc = createCrc32();
    let written = 0n;
    try {
      const downloadUrl = await getPublicNodeDownloadUrl(folderHandle, entry.node.hash);
      for await (const chunk of decryptedFileChunks(entry.node, downloadUrl)) {
        crc.update(chunk);
        written += BigInt(chunk.length);
        yield chunk;
      }
    } catch (err) {
      throw new Error(`Failed to stream "${entry.path}": ${err.message}`);
    }

    const finalCrc = crc.digest();
    const descriptor = buildDataDescriptor(finalCrc, Number(written), useZip64);
    yield descriptor;
    offset += BigInt(descriptor.length);

    centralRecords.push({
      nameBytes, crc: finalCrc, size: Number(written),
      offset: localHeaderOffset, dosTime, dosDate, isDir: false
    });
  }

  const cdStart = offset;
  for (const rec of centralRecords) {
    const useZip64Size = rec.size > ZIP64_THRESHOLD;
    const useZip64Offset = rec.offset > BigInt(ZIP64_THRESHOLD);
    const cdHeader = buildCentralDirHeader(
      rec.nameBytes, rec.crc, rec.size, Number(rec.offset),
      rec.dosTime, rec.dosDate, rec.isDir, useZip64Size, useZip64Offset
    );
    yield cdHeader;
    offset += BigInt(cdHeader.length);
  }
  const cdSize = offset - cdStart;
  const entryCount = centralRecords.length;
  const needZip64 = entryCount > 0xFFFF || cdSize > BigInt(ZIP64_THRESHOLD) || cdStart > BigInt(ZIP64_THRESHOLD);
  yield buildEOCD(entryCount, Number(cdSize), Number(cdStart), needZip64);
}

async function handlePublicFolderZip(url, folderHandle, keyB64) {
  const raw = url.searchParams.get("items") || "";
  const items = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (items.length === 0) {
    return new Response("No items selected. Provide ?items=hash1,hash2,...", { status: 400 });
  }

  const tree = await getOrFetchPublicTree(folderHandle, keyB64, false);
  const entries = resolveSelectionToEntries(tree, items);
  if (entries.length === 0) {
    return new Response("Selected items could not be resolved (they may no longer exist in this folder).", { status: 404 });
  }

  const gen = generateZipStream(tree, folderHandle, entries);
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      if (gen.return) { try { await gen.return(); } catch {} }
    }
  });

  const zipName = (entries.length === 1 && !entries[0].isDir)
    ? entries[0].node.name.replace(/[\\/":*?<>|]/g, "_") + ".zip"
    : "mega-download.zip";

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Cache-Control": "no-store"
    }
  });
}

function renderUI(tree, currentFolderHash, origin, opts) {
  opts = opts || { basePath: "", title: "Public MEGA Folder", subtitle: "" };
  const folderUrl = (hash) => `${opts.basePath}?sub=${hash}`;
  const downloadUrl = (hash) => `${opts.basePath}/download/${hash}`;
  const refreshUrl = `${opts.basePath}?refresh=1`;
  const zipEndpoint = `${opts.basePath}/zip`;

  const folder = tree.nodes[currentFolderHash];
  if (!folder) {
    return new Response("Folder Not Found", { status: 404 });
  }

  const breadcrumbs = [];
  let curr = folder;
  while (curr) {
    breadcrumbs.unshift(curr);
    curr = curr.parent ? tree.nodes[curr.parent] : null;
  }

  const breadcrumbsHtml = breadcrumbs.map((b, idx) => {
    const isLast = idx === breadcrumbs.length - 1;
    if (isLast) {
      return `<span class="text-indigo-300 font-semibold truncate max-w-[120px] md:max-w-xs">${escapeHtml(b.name)}</span>`;
    }
    return `
      <a href="${folderUrl(b.hash)}" class="hover:text-white transition-colors truncate max-w-[100px] md:max-w-[180px]">${escapeHtml(b.name)}</a>
      <span class="text-gray-600 mx-2 shrink-0">/</span>
    `;
  }).join("");

  const items = (folder.children || []).sort((a, b) => {
    if (a.type !== b.type) return b.type - a.type;
    return a.name.localeCompare(b.name);
  });

  let itemsListHtml = "";
  if (items.length === 0) {
    itemsListHtml = `
      <div class="text-center py-20 flex flex-col items-center justify-center">
        <svg class="w-16 h-16 text-gray-700 mb-4 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
        </svg>
        <span class="text-gray-500 text-base font-medium">This folder is empty</span>
      </div>
    `;
  } else {
    itemsListHtml = items.map(item => {
      const isFolder = item.type !== 0;
      const icon = isFolder
        ? `<svg class="w-10 h-10 text-indigo-400 group-hover:scale-110 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>`
        : `<svg class="w-10 h-10 text-cyan-400 group-hover:scale-110 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>`;
      const sizeStr = isFolder ? "--" : formatBytes(item.size);
      const targetUrl = isFolder ? folderUrl(item.hash) : downloadUrl(item.hash);
      const actionButton = isFolder
        ? `
          <button class="bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-white/5 transition-all duration-150">
            Open
          </button>
        `
        : `
          <div class="flex gap-2">
            <button onclick="copyToClipboard('${origin}${downloadUrl(item.hash)}', event)" class="bg-white/5 hover:bg-indigo-600/20 hover:text-indigo-300 text-gray-400 p-2 rounded-lg border border-white/5 transition-all duration-150 tooltip" title="Copy Direct Download Link">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
            </button>
            <a href="${targetUrl}" class="bg-indigo-600 hover:bg-indigo-500 text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-lg shadow-indigo-600/20 transition-all duration-150">
              Download
            </a>
          </div>
        `;

      return `
        <div onclick="navigate('${targetUrl}')" class="group flex items-center justify-between p-4 rounded-2xl hover:bg-white/[0.03] border border-transparent hover:border-white/5 transition-all duration-150 cursor-pointer">
          <div class="flex items-center gap-4 min-w-0 pr-4">
            <input type="checkbox" class="item-checkbox w-5 h-5 accent-indigo-500 shrink-0 rounded" data-hash="${item.hash}" onclick="event.stopPropagation(); onItemCheckboxChange(this)">
            ${icon}
            <div class="min-w-0">
              <span class="block text-sm font-semibold text-gray-200 group-hover:text-indigo-300 transition-colors truncate max-w-md md:max-w-xl">${escapeHtml(item.name)}</span>
              <span class="block text-xs text-gray-400 mt-0.5">${isFolder ? "Folder" : `File &bull; ${sizeStr}`}</span>
            </div>
          </div>
          <div class="shrink-0">
            ${actionButton}
          </div>
        </div>
      `;
    }).join("");
  }
  const backHomeBtn = `
      <a href="/" class="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-medium text-sm px-4 py-2.5 rounded-xl border border-white/10 transition-all duration-150">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
        Home
      </a>
    `;

  return new Response(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)}</title>
<!-- Tailwind CSS Play CDN -->
<script src="https://cdn.tailwindcss.com"></script>
<!-- Google Fonts Inter -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
body {
  font-family: 'Inter', sans-serif;
  background: radial-gradient(circle at top left, #0e111d 0%, #07080e 100%);
}
.glass {
  background: rgba(255, 255, 255, 0.02);
  backdrop-filter: blur(20px);
  border: 1px border rgba(255, 255, 255, 0.05);
}
</style>
</head>
<body class="min-h-screen text-gray-200 p-4 md:p-8 flex justify-center items-start">
<div class="w-full max-w-5xl flex flex-col gap-6 mt-4 pb-24">

  <!-- Header -->
  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 glass rounded-3xl p-6 border border-white/5 shadow-2xl">
    <div>
      <h1 class="text-2xl font-bold bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">${escapeHtml(opts.title)}</h1>
      <p class="text-xs text-gray-400 mt-1">${escapeHtml(opts.subtitle)}</p>
    </div>
    <div class="flex gap-3 flex-wrap">
      ${backHomeBtn}
      <!-- NEW: Index Public Link button (occupies the space to the left of Refresh) -->
      <button onclick="togglePublicForm()" class="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-sm px-4 py-2.5 rounded-xl transition-all duration-150 shadow-lg shadow-cyan-600/20">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
        Index Public Link
      </button>
      <a href="${refreshUrl}" class="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm px-4 py-2.5 rounded-xl transition-all duration-150 shadow-lg shadow-indigo-600/20">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.228 9H18.01"></path></svg>
        Refresh Index
      </a>
    </div>
  </div>

  <!-- NEW: Public Link Input Panel (hidden by default) -->
  <div id="publicForm" class="hidden glass rounded-3xl p-6 border border-white/5 shadow-2xl flex-col gap-3">
    <label class="text-sm font-semibold text-gray-300">Paste a public mega.nz link</label>
    <p class="text-xs text-gray-500">Supports folder links (https://mega.nz/folder/HANDLE#KEY) and file links (https://mega.nz/file/HANDLE#KEY). Folder links open a browsable index; file links download directly.</p>
    <div class="flex flex-col md:flex-row gap-3">
      <input type="text" id="publicLinkInput" placeholder="https://mega.nz/folder/xxxxxxxx#yyyyyyyyyyyyyyyyyyyyyy" class="flex-1 bg-white/5 border border-white/10 rounded-xl py-2.5 px-4 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors duration-150" onkeydown="if(event.key==='Enter')openPublicLink()">
      <button onclick="openPublicLink()" class="bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-sm px-6 py-2.5 rounded-xl transition-all duration-150 shadow-lg shadow-cyan-600/20">
        Index It
      </button>
    </div>
    <p id="publicLinkError" class="hidden text-xs text-red-400"></p>
  </div>

  <!-- Directory Explorer -->
  <div class="glass rounded-3xl p-6 border border-white/5 shadow-2xl flex flex-col gap-4">
    <!-- Navigation Breadcrumbs & Search -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-white/5">
      <div class="flex items-center overflow-x-auto min-w-0 pr-4 py-1">
        <svg class="w-5 h-5 text-gray-500 mr-2 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
        ${breadcrumbsHtml}
      </div>
      <!-- Client Filter Search Bar -->
      <div class="relative shrink-0 w-full md:w-64">
        <input type="text" id="searchInput" oninput="filterItems()" placeholder="Search in directory..." class="w-full bg-white/5 border border-white/10 rounded-xl py-2 pl-9 pr-4 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors duration-150">
        <svg class="w-4 h-4 text-gray-500 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
      </div>
    </div>

    <!-- NEW: Select All / Clear row -->
    <div class="flex items-center justify-between px-1">
      <label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
        <input type="checkbox" id="selectAllCheckbox" onclick="toggleSelectAll(this)" class="w-4 h-4 accent-indigo-500 rounded">
        Select all in this folder
      </label>
      <button onclick="clearSelection()" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">Clear selection</button>
    </div>

    <!-- Items List Container -->
    <div class="flex flex-col" id="itemsList">
      ${itemsListHtml}
    </div>
  </div>
</div>

<!-- NEW: Floating "Download as ZIP" bar, shown only when something is selected -->
<div id="zipBar" class="hidden fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-4 bg-gray-900 border border-white/10 shadow-2xl rounded-2xl px-5 py-3.5">
  <span id="zipCount" class="text-sm font-medium text-gray-200">0 items selected</span>
  <button onclick="downloadZip()" class="bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-sm px-4 py-2 rounded-xl transition-all duration-150 shadow-lg shadow-cyan-600/20 flex items-center gap-2">
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"></path></svg>
    Download as ZIP
  </button>
</div>

<!-- Toast Notification Box -->
<div id="toast" class="fixed bottom-6 right-6 transform translate-y-12 opacity-0 bg-gray-900 border border-white/10 px-5 py-3.5 rounded-2xl flex items-center gap-2.5 shadow-2xl transition-all duration-300 pointer-events-none">
  <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
  <span class="text-sm font-medium text-gray-200" id="toastMessage">Link copied to clipboard</span>
</div>

<script>
function navigate(url) {
  window.location.href = url;
}

function filterItems() {
  const query = document.getElementById("searchInput").value.toLowerCase();
  const items = document.querySelectorAll("#itemsList > div");
  items.forEach(item => {
    const nameEl = item.querySelector("span");
    if (nameEl) {
      const name = nameEl.textContent.toLowerCase();
      if (name.includes(query)) {
        item.style.display = "flex";
      } else {
        item.style.display = "none";
      }
    }
  });
}

function copyToClipboard(text, event) {
  event.stopPropagation(); // prevent folder navigation trigger
  navigator.clipboard.writeText(text).then(() => {
    showToast("Direct link copied!");
  });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  const msgEl = document.getElementById("toastMessage");
  msgEl.textContent = message;
  toast.classList.remove("translate-y-12", "opacity-0");
  setTimeout(() => {
    toast.classList.add("translate-y-12", "opacity-0");
  }, 2500);
}
function togglePublicForm() {
  const form = document.getElementById("publicForm");
  form.classList.toggle("hidden");
  form.classList.toggle("flex");
  if (!form.classList.contains("hidden")) {
    document.getElementById("publicLinkInput").focus();
  }
}

function parseMegaLinkClient(link) {
  link = link.trim();
  let m = link.match(/mega(?:\\.co)?\\.nz\\/(folder|file)\\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/);
  if (m) return { type: m[1], handle: m[2], key: m[3] };
  m = link.match(/mega(?:\\.co)?\\.nz\\/#F!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
  if (m) return { type: "folder", handle: m[1], key: m[2] };
  m = link.match(/mega(?:\\.co)?\\.nz\\/#!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
  if (m) return { type: "file", handle: m[1], key: m[2] };
  return null;
}

function openPublicLink() {
  const input = document.getElementById("publicLinkInput");
  const errEl = document.getElementById("publicLinkError");
  const parsed = parseMegaLinkClient(input.value);
  if (!parsed) {
    errEl.textContent = "That doesn't look like a valid mega.nz public link. Make sure it includes the # decryption key.";
    errEl.classList.remove("hidden");
    return;
  }
  errEl.classList.add("hidden");
  if (parsed.type === "folder") {
    window.location.href = "/p/" + parsed.handle + "/" + parsed.key;
  } else {
    window.location.href = "/pf/" + parsed.handle + "/" + parsed.key;
  }
}

const ZIP_STORAGE_KEY = "megaZipSelection:" + ${JSON.stringify(opts.basePath)};
const ZIP_ENDPOINT = ${JSON.stringify(zipEndpoint)};

function loadSelection() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(ZIP_STORAGE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveSelection(set) {
  try { sessionStorage.setItem(ZIP_STORAGE_KEY, JSON.stringify(Array.from(set))); } catch {}
}

let selection = loadSelection();

function onItemCheckboxChange(el) {
  const hash = el.dataset.hash;
  if (el.checked) selection.add(hash); else selection.delete(hash);
  saveSelection(selection);
  updateZipBar();
  syncSelectAllState();
}

function toggleSelectAll(el) {
  const boxes = document.querySelectorAll(".item-checkbox");
  boxes.forEach(cb => {
    cb.checked = el.checked;
    if (el.checked) selection.add(cb.dataset.hash); else selection.delete(cb.dataset.hash);
  });
  saveSelection(selection);
  updateZipBar();
}

function syncSelectAllState() {
  const boxes = document.querySelectorAll(".item-checkbox");
  const selectAll = document.getElementById("selectAllCheckbox");
  if (!selectAll || boxes.length === 0) return;
  selectAll.checked = Array.from(boxes).every(cb => cb.checked);
}

function updateZipBar() {
  const bar = document.getElementById("zipBar");
  const count = document.getElementById("zipCount");
  if (selection.size > 0) {
    bar.classList.remove("hidden");
    count.textContent = selection.size + (selection.size === 1 ? " item selected" : " items selected");
  } else {
    bar.classList.add("hidden");
  }
}

function downloadZip() {
  if (selection.size === 0) return;
  const items = Array.from(selection).join(",");
  window.location.href = ZIP_ENDPOINT + "?items=" + encodeURIComponent(items);
}

function clearSelection() {
  selection = new Set();
  saveSelection(selection);
  document.querySelectorAll(".item-checkbox").forEach(cb => cb.checked = false);
  updateZipBar();
  syncSelectAllState();
}

document.querySelectorAll(".item-checkbox").forEach(cb => {
  cb.checked = selection.has(cb.dataset.hash);
});
updateZipBar();
syncSelectAllState();
</script>
</body>
</html>
`, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8"
    }
  });
}

function renderLanding() {
  return new Response(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MEGA Link Indexer</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
body {
  font-family: 'Inter', sans-serif;
  background: radial-gradient(circle at top left, #0e111d 0%, #07080e 100%);
}
.glass {
  background: rgba(255, 255, 255, 0.02);
  backdrop-filter: blur(20px);
  border: 1px border rgba(255, 255, 255, 0.05);
}
</style>
</head>
<body class="min-h-screen text-gray-200 p-4 md:p-8 flex justify-center items-center">
<div class="w-full max-w-2xl flex flex-col gap-6">

  <div class="glass rounded-3xl p-8 md:p-10 border border-white/5 shadow-2xl flex flex-col gap-6">
    <div class="flex flex-col items-center text-center gap-3">
      <svg class="w-14 h-14 text-cyan-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
      <h1 class="text-3xl font-bold bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">MEGA Link Indexer</h1>
      <p class="text-sm text-gray-400 max-w-md">Paste a public mega.nz shared link below to browse and download its files. No MEGA account needed.</p>
    </div>

    <div class="flex flex-col gap-3">
      <input type="text" id="publicLinkInput" placeholder="https://mega.nz/folder/xxxxxxxx#yyyyyyyyyyyyyyyy" class="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors duration-150" onkeydown="if(event.key==='Enter')openPublicLink()" autofocus>
      <button onclick="openPublicLink()" class="bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-sm px-6 py-3 rounded-xl transition-all duration-150 shadow-lg shadow-cyan-600/20">
        Index It
      </button>
      <p id="publicLinkError" class="hidden text-xs text-red-400"></p>
      <p class="text-xs text-gray-500 text-center">Supports folder links (mega.nz/folder/HANDLE#KEY) and file links (mega.nz/file/HANDLE#KEY). Old #F!h!k and #!h!k formats work too.</p>
    </div>
  </div>
</div>

<script>
function parseMegaLinkClient(link) {
  link = link.trim();
  let m = link.match(/mega(?:\\.co)?\\.nz\\/(folder|file)\\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/);
  if (m) return { type: m[1], handle: m[2], key: m[3] };
  m = link.match(/mega(?:\\.co)?\\.nz\\/#F!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
  if (m) return { type: "folder", handle: m[1], key: m[2] };
  m = link.match(/mega(?:\\.co)?\\.nz\\/#!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
  if (m) return { type: "file", handle: m[1], key: m[2] };
  return null;
}

function openPublicLink() {
  const input = document.getElementById("publicLinkInput");
  const errEl = document.getElementById("publicLinkError");
  const parsed = parseMegaLinkClient(input.value);
  if (!parsed) {
    errEl.textContent = "That doesn't look like a valid mega.nz public link. Make sure it includes the # decryption key.";
    errEl.classList.remove("hidden");
    return;
  }
  errEl.classList.add("hidden");
  if (parsed.type === "folder") {
    window.location.href = "/p/" + parsed.handle + "/" + parsed.key;
  } else {
    window.location.href = "/pf/" + parsed.handle + "/" + parsed.key;
  }
}
</script>
</body>
</html>
`, {
    headers: { "Content-Type": "text/html; charset=UTF-8" }
  });
}

function renderFileUI(meta, basePath) {
  const downloadHref = `${basePath}/download`;
  const sizeStr = formatBytes(meta.size);
  return new Response(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(meta.name)}</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
body {
  font-family: 'Inter', sans-serif;
  background: radial-gradient(circle at top left, #0e111d 0%, #07080e 100%);
}
.glass {
  background: rgba(255, 255, 255, 0.02);
  backdrop-filter: blur(20px);
  border: 1px border rgba(255, 255, 255, 0.05);
}
</style>
</head>
<body class="min-h-screen text-gray-200 p-4 md:p-8 flex justify-center items-start">
<div class="w-full max-w-3xl flex flex-col gap-6 mt-4">

  <!-- Header -->
  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 glass rounded-3xl p-6 border border-white/5 shadow-2xl">
    <div>
      <h1 class="text-2xl font-bold bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">Public MEGA File</h1>
      <p class="text-xs text-gray-400 mt-1">Indexed from a public mega.nz shared file link</p>
    </div>
    <div class="flex gap-3 flex-wrap">
      <a href="/" class="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-medium text-sm px-4 py-2.5 rounded-xl border border-white/10 transition-all duration-150">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
        Home
      </a>
    </div>
  </div>

  <!-- File Card -->
  <div class="glass rounded-3xl p-6 border border-white/5 shadow-2xl">
    <div class="flex items-center justify-between p-4 rounded-2xl border border-white/5">
      <div class="flex items-center gap-4 min-w-0 pr-4">
        <svg class="w-10 h-10 text-cyan-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
        <div class="min-w-0">
          <span class="block text-sm font-semibold text-gray-200 truncate max-w-md md:max-w-xl">${escapeHtml(meta.name)}</span>
          <span class="block text-xs text-gray-400 mt-0.5">File &bull; ${sizeStr}</span>
        </div>
      </div>
      <div class="shrink-0 flex gap-2">
        <button onclick="copyToClipboard(window.location.origin + '${downloadHref}', event)" class="bg-white/5 hover:bg-indigo-600/20 hover:text-indigo-300 text-gray-400 p-2 rounded-lg border border-white/5 transition-all duration-150" title="Copy Direct Download Link">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
        </button>
        <a href="${downloadHref}" class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-lg shadow-indigo-600/20 transition-all duration-150">
          Download
        </a>
      </div>
    </div>
  </div>
</div>

<!-- Toast -->
<div id="toast" class="fixed bottom-6 right-6 transform translate-y-12 opacity-0 bg-gray-900 border border-white/10 px-5 py-3.5 rounded-2xl flex items-center gap-2.5 shadow-2xl transition-all duration-300 pointer-events-none">
  <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
  <span class="text-sm font-medium text-gray-200" id="toastMessage">Link copied to clipboard</span>
</div>

<script>
function copyToClipboard(text, event) {
  event.stopPropagation();
  navigator.clipboard.writeText(text).then(() => showToast("Direct link copied!"));
}
function showToast(message) {
  const toast = document.getElementById("toast");
  document.getElementById("toastMessage").textContent = message;
  toast.classList.remove("translate-y-12", "opacity-0");
  setTimeout(() => toast.classList.add("translate-y-12", "opacity-0"), 2500);
}
</script>
</body>
</html>
`, {
    headers: { "Content-Type": "text/html; charset=UTF-8" }
  });
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
