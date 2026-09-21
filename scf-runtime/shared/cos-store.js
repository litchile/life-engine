import COS from "cos-nodejs-sdk-v5";
import { lifeEngineConfig } from "./life-engine-config.js";
import { createScopedStore } from "./scoped-store.js";

function credentials(context = {}) {
  return {
    SecretId: context.secretId || process.env.TENCENTCLOUD_SECRETID,
    SecretKey: context.secretKey || process.env.TENCENTCLOUD_SECRETKEY,
    SecurityToken: context.token || process.env.TENCENTCLOUD_SESSIONTOKEN,
  };
}

export function createStore(context = {}, { prefix = lifeEngineConfig().instance.storage_prefix } = {}) {
  const Bucket = process.env.COS_BUCKET;
  const Region = process.env.COS_REGION || "ap-guangzhou";
  if (!Bucket) throw new Error("COS_BUCKET is required");
  const cos = new COS(credentials(context));

  const invoke = (method, params) => new Promise((resolve, reject) => {
    cos[method]({ Bucket, Region, ...params }, (error, data) => error ? reject(error) : resolve(data));
  });

  const store = {
    async putJson(Key, value) {
      await invoke("putObject", {
        Key,
        Body: JSON.stringify(value),
        ContentType: "application/json; charset=utf-8",
      });
    },
    async putObject(Key, body, contentType = "application/octet-stream") {
      await invoke("putObject", {
        Key,
        Body: body,
        ContentType: contentType,
      });
    },
    async tryAcquireLock(Key, owner, ttlMs = 240_000) {
      const now = Date.now();
      try {
        const current = await this.getJson(Key, null);
        if (current && Number(current.expires_at || 0) <= now) {
          await invoke("deleteObject", { Key });
        }
      } catch (error) {
        if (error?.statusCode !== 404 && error?.code !== "NoSuchKey") throw error;
      }
      const body = Buffer.from(JSON.stringify({ owner, acquired_at: now, expires_at: now + ttlMs }));
      try {
        await invoke("appendObject", {
          Key,
          Body: body,
          Position: 0,
          ContentLength: body.length,
          ContentType: "application/json; charset=utf-8",
          // cos-nodejs-sdk-v5's appendObject implementation reads
          // params.Headers unconditionally. Keep this explicit so a real COS
          // invocation does not fail before the lock request is sent.
          Headers: {},
        });
        return true;
      } catch (error) {
        if ([409, 412].includes(Number(error?.statusCode))
          || /Position|Append|Conflict|Precondition/i.test(String(error?.code || error?.message || ""))) {
          return false;
        }
        // Some COS bucket configurations do not support appendable objects.
        // Fall back to a short verified lease rather than making the bot stop
        // replying. The write/read verification still prevents ordinary SCF
        // overlap, while the append path remains the preferred atomic path.
        const lease = { owner, acquired_at: now, expires_at: now + ttlMs, mode: "verified_lease" };
        await this.putJson(Key, lease);
        await new Promise((resolve) => setTimeout(resolve, 120 + Math.floor(Math.random() * 80)));
        const verified = await this.getJson(Key, null);
        return verified?.owner === owner;
      }
    },
    async releaseLock(Key, owner) {
      try {
        const current = await this.getJson(Key, null);
        if (current?.owner === owner) await invoke("deleteObject", { Key });
      } catch (error) {
        if (error?.statusCode !== 404 && error?.code !== "NoSuchKey") throw error;
      }
    },
    async getJson(Key, fallback = null) {
      try {
        const data = await invoke("getObject", { Key });
        return JSON.parse(Buffer.from(data.Body).toString("utf8"));
      } catch (error) {
        if (error?.statusCode === 404 || error?.code === "NoSuchKey") return fallback;
        throw error;
      }
    },
    async getObject(Key) {
      const data = await invoke("getObject", { Key });
      return {
        body: Buffer.from(data.Body),
        contentType: data.headers?.["content-type"] || "application/octet-stream",
      };
    },
    async exists(Key) {
      try {
        await invoke("headObject", { Key });
        return true;
      } catch (error) {
        if (error?.statusCode === 404 || error?.code === "NoSuchKey") return false;
        throw error;
      }
    },
    async listKeys(Prefix, limit = 100) {
      const maximum = Math.max(1, Math.min(1000, Number(limit) || 100));
      const keys = [];
      let Marker;
      while (keys.length < maximum) {
        const data = await invoke("getBucket", {
          Prefix,
          Marker,
          MaxKeys: Math.min(1000, maximum - keys.length),
        });
        for (const item of Array.isArray(data.Contents) ? data.Contents : []) {
          if (item?.Key) keys.push(String(item.Key));
          if (keys.length >= maximum) break;
        }
        const truncated = data.IsTruncated === true || String(data.IsTruncated).toLowerCase() === "true";
        if (!truncated || !data.NextMarker) break;
        Marker = data.NextMarker;
      }
      return keys;
    },
  };
  return createScopedStore(store, prefix);
}

export function objectKeyFromCosRecord(record) {
  const raw = record?.cos?.cosObject?.key || "";
  const appId = record?.cos?.cosBucket?.appid;
  const bucketName = record?.cos?.cosBucket?.name;
  let key = decodeURIComponent(String(raw).replace(/^\//, "").replace(/\+/g, "%20"));
  const bucketPrefix = appId && bucketName ? `${appId}/${bucketName}/` : "";
  if (bucketPrefix && key.startsWith(bucketPrefix)) key = key.slice(bucketPrefix.length);
  return key;
}
