import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";

const MAX_HTML = 3500000;
const TIMEOUT = 12000;
const IMAGE_TIMEOUT = 3500;

function isPrivate(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 192 && p[1] === 0) ||
      (p[0] === 198 && [18, 19].includes(p[1])) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113)
    );
  }

  if (net.isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return (
      v === "::" ||
      v === "::1" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      /^fe[89ab]/.test(v) ||
      v.startsWith("::ffff:")
    );
  }

  return true;
}

async function checkUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw Error("URL không hợp lệ");
  }

  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port))
  )
    throw Error("URL không hợp lệ");

  const host = u.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    net.isIP(host)
  )
    throw Error("Tên miền không được hỗ trợ");

  const addresses = await dns.lookup(host, { all: true });

  if (!addresses.length || addresses.some((x) => isPrivate(x.address))) {
    throw Error("Địa chỉ mạng không an toàn");
  }

  return u;
}

function absolute(raw, base) {
  if (typeof raw !== "string" || !raw.trim()) return null;

  try {
    let s = raw
      .trim()
      .replace(/&amp;/g, "&")
      .replace(/\\u002F/gi, "/")
      .replace(/\\\//g, "/");

    if (s.startsWith("//")) s = "https:" + s;

    const u = new URL(s, base);
    if (!["http:", "https:"].includes(u.protocol)) return null;

    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function isImage(url) {
  try {
    const p = new URL(url).pathname;
    return (
      /\.(png|jpe?g|webp|avif)$/i.test(p) ||
      /\/(?:image|images|img|media|product|cdn)\//i.test(p)
    );
  } catch {
    return false;
  }
}

function unwanted(url) {
  try {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).toLowerCase();

    return [
      /logo/,
      /favicon/,
      /icon/,
      /avatar/,
      /badge/,
      /sprite/,
      /payment/,
      /paypal/,
      /visa/,
      /mastercard/,
      /trust[-_]?symbol/,
      /placeholder/,
      /banner/,
      /social/,
      /review/,
      /rating/,
      /size[-_]?chart/,
      /size[-_]?guide/,
      /sizing/,
      /measurement/,
      /shipping/,
      /footer/,
      /header/,
      /commercegurus/,
      /shopitimizer/,
    ].some((re) => re.test(p) || re.test(u.hostname));
  } catch {
    return true;
  }
}

function parseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function srcsetItems(value) {
  return (value || "")
    .split(",")
    .map((x) => x.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function identity(url) {
  const u = new URL(url);
  let path = decodeURIComponent(u.pathname).toLowerCase();

  path = path.replace(/\/img\/\d+\/\d+\/resize\//i, "/img/resize/");

  if (/shopify/i.test(u.hostname)) {
    path = path.replace(/_(?:\d+x\d*|x\d+)(?=\.(?:jpe?g|png|webp|avif)$)/i, "");
  }

  const host = /^(minio\.storedfilezone\.com|minio\.cacheimg\.com)$/i.test(
    u.hostname,
  )
    ? "minio"
    : u.hostname.toLowerCase();

  return host + path;
}

function resolution(url) {
  const u = new URL(url);
  const p = u.pathname;

  const m = p.match(/\/img\/(\d+)\/(\d+)\/resize\//i);
  if (m) return Math.max(Number(m[1]), Number(m[2]));

  const shop = p.match(/_(\d+)x(\d*)\.(?:jpe?g|png|webp|avif)$/i);
  if (shop) return Math.max(Number(shop[1]), Number(shop[2] || 0));

  return Number(u.searchParams.get("width") || u.searchParams.get("w") || 0);
}

function deduplicate(items) {
  const map = new Map();

  for (const item of items) {
    if (!isImage(item.url) || unwanted(item.url)) continue;

    const key = identity(item.url);
    const old = map.get(key);

    if (!old) {
      map.set(key, {
        ...item,
        candidates: [item.url],
      });
      continue;
    }

    map.set(key, {
      url: resolution(item.url) > resolution(old.url) ? item.url : old.url,
      score: Math.max(old.score, item.score),
      source: item.score > old.score ? item.source : old.source,
      candidates: [...new Set([...old.candidates, item.url])],
    });
  }

  return [...map.values()].sort((a, b) => b.score - a.score);
}

function collectJSONLD(obj, add, depth = 0) {
  if (!obj || depth > 12) return;

  if (Array.isArray(obj)) {
    obj.forEach((x) => collectJSONLD(x, add, depth + 1));
    return;
  }

  if (typeof obj !== "object") return;

  const types = []
    .concat(obj["@type"] || [])
    .map((x) => String(x).toLowerCase());

  if (types.some((x) => x.endsWith("product") || x === "productgroup")) {
    for (const image of [].concat(obj.image || obj.images || [])) {
      add(
        typeof image === "string" ? image : image?.url || image?.contentUrl,
        100,
        "Product JSON-LD",
      );
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "image" || key === "images") continue;
    if (typeof value === "object") collectJSONLD(value, add, depth + 1);
  }
}

function collectAttributes($, el, add, score, source) {
  const node = $(el);

  for (const key of [
    "data-zoom-image",
    "data-large_image",
    "data-full",
    "data-src",
    "data-original",
    "data-image",
    "data-lazy-src",
    "data-thumb",
    "data-thumbnail",
    "data-product-image",
    "src",
    "href",
  ]) {
    add(node.attr(key), score, source);
  }

  for (const key of ["srcset", "data-srcset"]) {
    for (const url of srcsetItems(node.attr(key))) {
      add(url, score, source);
    }
  }
}

function excludedContainer($, el) {
  return (
    $(el).closest(
      [
        '[class*="recommend"]',
        '[class*="related"]',
        '[class*="upsell"]',
        '[class*="cross-sell"]',
        '[class*="review"]',
        '[class*="footer"]',
        '[class*="header"]',
        "header",
        "footer",
        "nav",
      ].join(","),
    ).length > 0
  );
}

// Chỉ kiểm tra URL trên host đã xác thực.

async function imageWorks(url) {
  try {
    await checkUrl(url);

    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*",
        Range: "bytes=0-63",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });

    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }

    const type = (response.headers.get("content-type") || "").toLowerCase();

    const disposition = (
      response.headers.get("content-disposition") || ""
    ).toLowerCase();

    // Trường hợp server trả Content-Type chuẩn.
    if (type.startsWith("image/")) {
      await response.body?.cancel();
      return true;
    }

    // Một số website trả ảnh dưới dạng file tải xuống.
    // Kiểm tra chữ ký dữ liệu thay vì chỉ tin tên file.
    if (
      type.includes("application/octet-stream") ||
      disposition.includes("attachment") ||
      !type
    ) {
      if (!response.body) return false;

      const reader = response.body.getReader();
      const { value } = await reader.read();
      await reader.cancel();

      if (!value || value.length < 12) return false;

      const bytes = value;

      // JPEG
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

      // PNG
      const png =
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47;

      // GIF
      const gif =
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38;

      // WEBP
      const webp =
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";

      // AVIF
      const avif =
        String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" &&
        ["avif", "avis"].includes(String.fromCharCode(...bytes.slice(8, 12)));

      return jpeg || png || gif || webp || avif;
    }

    await response.body?.cancel();
    return false;
  } catch (error) {
    console.error("Image check failed:", url, error.message);
    return false;
  }
}

function imageCandidates(item) {
  const urls = [...(item.candidates || []), item.url];

  for (const raw of [...urls]) {
    try {
      const u = new URL(raw);

      if (
        !["minio.cacheimg.com", "minio.storedfilezone.com"].includes(u.hostname)
      )
        continue;

      for (const host of ["minio.storedfilezone.com", "minio.cacheimg.com"]) {
        for (const size of [2048, 1080, 720, 600]) {
          const candidate = new URL(raw);
          candidate.hostname = host;
          candidate.pathname = candidate.pathname.replace(
            /\/img\/\d+\/\d+\/resize\//i,
            `/img/${size}/0/resize/`,
          );
          urls.push(candidate.href);
        }
      }
    } catch {}
  }

  return [...new Set(urls)].sort((a, b) => resolution(b) - resolution(a));
}

async function findWorkingImage(item) {
  const candidates = imageCandidates(item);

  for (const url of candidates.slice(0, 20)) {
    const valid = await imageWorks(url);

    if (valid) {
      return url;
    }
  }

  return null;
}

export async function extractOne(input) {
  let current = (await checkUrl(input)).href;
  let response;

  for (let i = 0; i < 4; i++) {
    response = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = absolute(response.headers.get("location"), current);
      if (!next) throw Error("Redirect không hợp lệ");

      current = (await checkUrl(next)).href;
      continue;
    }

    break;
  }

  if (!response || !response.ok) {
    throw Error("Trang trả về HTTP " + (response?.status || "redirect"));
  }

  if (!(response.headers.get("content-type") || "").includes("html")) {
    throw Error("URL không phải trang HTML");
  }

  const len = Number(response.headers.get("content-length") || 0);
  if (len > MAX_HTML) throw Error("Trang quá lớn");

  const html = (await response.text()).slice(0, MAX_HTML);
  const $ = cheerio.load(html);
  const found = [];

  const add = (raw, score, source) => {
    const url = absolute(raw, current);

    if (!url || !isImage(url) || unwanted(url)) return;

    found.push({ url, score, source });
  };

  // 1. Product JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    collectJSONLD(parseJSON($(el).html()), add);
  });

  // 2. Product gallery: selectors cụ thể.
  const gallerySelectors = [
    '[class*="product-gallery"]',
    '[class*="productGallery"]',
    '[class*="product-images"]',
    '[class*="productImages"]',
    '[class*="product-media"]',
    '[class*="productMedia"]',
    '[class*="product__media"]',
    '[class*="product__gallery"]',
    '[id*="product-gallery"]',
    '[class*="product-single__media"]',
    '[class*="product__thumb"]',
    '[class*="product-thumbnail"]',
    '[class*="product-image"]',
    '[class*="productImage"]',
    "[data-product-image]",
    "[data-zoom-image]",
    ".woocommerce-product-gallery",
    ".woocommerce-product-gallery__wrapper",
  ];

  const gallery = gallerySelectors.join(",");

  $(gallery)
    .find("img,source,a,[data-image],[data-zoom-image]")
    .addBack("img,source,a,[data-image],[data-zoom-image]")
    .each((_, el) => {
      if (excludedContainer($, el)) return;
      collectAttributes($, el, add, 95, "Product gallery");
    });

  // 3. WooCommerce gallery: chỉ ảnh trong gallery chính.
  $(".woocommerce-product-gallery__image").each((_, el) => {
    if (excludedContainer($, el)) return;

    collectAttributes($, el, add, 100, "WooCommerce gallery");

    $(el)
      .find("img,a,source")
      .each((__, child) => {
        collectAttributes($, child, add, 100, "WooCommerce gallery");
      });
  });

  // 4. Thumbnails thuộc gallery sản phẩm.
  $(
    [
      ".product-single__thumbnails img",
      ".product__thumbnails img",
      "[data-product-thumbnail] img",
      "[data-thumbnail-id] img",
      "img[data-media-id]",
    ].join(","),
  ).each((_, el) => {
    if (excludedContainer($, el)) return;
    collectAttributes($, el, add, 90, "Product thumbnails");
  });

  // 5. JSON dữ liệu sản phẩm.
  $(
    'script[type="application/json"],script[id*="ProductJson"],script[id*="product-json"]',
  ).each((_, el) => {
    const id =
      ($(el).attr("id") || "") + " " + ($(el).attr("data-product") || "");

    if (!/product|variant/i.test(id)) return;

    const obj = parseJSON($(el).html());
    if (!obj) return;

    const walk = (value, depth = 0) => {
      if (!value || depth > 10) return;

      if (Array.isArray(value)) {
        value.forEach((x) => walk(x, depth + 1));
        return;
      }

      if (typeof value !== "object") return;

      for (const [key, item] of Object.entries(value)) {
        if (
          /^(images?|featured_image|featured_media|src|original_src|preview_image)$/i.test(
            key,
          )
        ) {
          if (typeof item === "string") {
            add(item, 95, "Product data");
          } else {
            walk(item, depth + 1);
          }
        } else if (typeof item === "object") {
          walk(item, depth + 1);
        }
      }
    };

    walk(obj);
  });

  // 6. Shopify endpoint: nếu được hỗ trợ.
  const productPath = new URL(current).pathname.match(
    /^(.*\/products\/[^/?#]+)/i,
  );

  if (productPath) {
    try {
      const endpoint = new URL(current);
      endpoint.pathname = productPath[1] + ".js";
      endpoint.search = "";
      endpoint.hash = "";

      const r = await fetch(endpoint.href, {
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      });

      if (r.ok && /json/i.test(r.headers.get("content-type") || "")) {
        const product = parseJSON((await r.text()).slice(0, 1500000));

        for (const item of product?.images || []) {
          add(
            typeof item === "string" ? item : item?.src || item?.url,
            110,
            "Shopify gallery",
          );
        }

        for (const item of product?.media || []) {
          if (item?.media_type && item.media_type !== "image") continue;
          add(item?.src || item?.preview_image?.src, 110, "Shopify gallery");
        }
      }
    } catch {}
  }

  // 7. Open Graph: chỉ fallback nếu không tìm được gallery.
  const og = [];

  $('meta[property="og:image"],meta[name="twitter:image"]').each((_, el) => {
    const url = absolute($(el).attr("content"), current);
    if (url && isImage(url) && !unwanted(url)) {
      og.push({ url, score: 50, source: "Open Graph" });
    }
  });

  // 8. Chỉ lấy ảnh có nguồn đáng tin cậy.
  let list = deduplicate(found);

  if (!list.length) {
    list = deduplicate(og);
  }

  list = list.slice(0, 30);

  // 9. Kiểm tra URL thực sự hoạt động.
  const checked = await Promise.all(
    list.map(async (item) => {
      const url = await findWorkingImage(item);
      return url ? { ...item, url } : null;
    }),
  );

  const valid = deduplicate(checked.filter(Boolean));

  return {
    page: input,
    finalUrl: current,
    count: valid.length,
    images: valid.map((x) => x.url),
    sources: [...new Set(valid.map((x) => x.source))],
    note:
      "Chỉ lấy ảnh từ gallery hoặc dữ liệu sản phẩm; " +
      "đã lọc ảnh phụ trợ, URL trùng và URL không truy cập được.",
  };
}
