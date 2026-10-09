import { chromium } from "playwright-core";

const HOST = "viralstyle.com";
const ASSET = "assets.viralstyle.com";

const EXT = /\.(?:jpe?g|png|webp|avif)$/i;
const SIDE =
  /-(front|back|left|right|side)(?:-(small|medium|large|thumb))?\.(?:jpe?g|png|webp|avif)$/i;
const SIZE = /-(small|medium|large|thumb)(?=\.(?:jpe?g|png|webp|avif)$)/i;

const QUALITY = {
  thumb: 1,
  small: 2,
  medium: 3,
  large: 4,
};

const MAX_VARIANTS = 16;
const MAX_IMAGE_CHECKS = 20;

function validPage(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("URL không hợp lệ");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === HOST || url.hostname.endsWith("." + HOST))
  ) {
    throw new Error("Chỉ hỗ trợ URL HTTPS của viralstyle.com");
  }

  url.searchParams.delete("fbclid");
  url.hash = "";

  return url;
}

function campaignUrl(raw) {
  try {
    const url = new URL(raw);

    if (
      url.protocol !== "https:" ||
      url.hostname !== ASSET ||
      !/^\/campaigns\/[a-f0-9-]{20,}\//i.test(url.pathname) ||
      !EXT.test(url.pathname) ||
      !SIDE.test(url.pathname)
    ) {
      return null;
    }

    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function campaignId(raw) {
  return new URL(raw).pathname.split("/")[2];
}

function imageKey(raw) {
  return new URL(raw).pathname.toLowerCase().replace(SIZE, "");
}

function quality(raw) {
  const match = new URL(raw).pathname.match(SIZE);

  return QUALITY[match?.[1]?.toLowerCase()] || 2;
}

function imageSide(raw) {
  const match = new URL(raw).pathname.match(SIDE);
  return match?.[1]?.toLowerCase() || "other";
}

function garmentKey(raw) {
  return new URL(raw).pathname.replace(
    /-(front|back|left|right|side)(?:-(small|medium|large|thumb))?\.(?:jpe?g|png|webp|avif)$/i,
    "",
  );
}

// Gộp các kích thước nhưng không gộp front/back.
function normalizeUrls(urls, preferredId, preferredGarment) {
  const counts = new Map();

  for (const raw of urls) {
    const url = campaignUrl(raw);
    if (!url) continue;

    const id = campaignId(url);
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const id =
    preferredId && counts.has(preferredId)
      ? preferredId
      : [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const unique = new Map();

  for (const raw of urls) {
    const url = campaignUrl(raw);

    if (!url || campaignId(url) !== id) continue;

    const key = imageKey(url);
    const old = unique.get(key);

    if (!old || quality(url) > quality(old)) {
      unique.set(key, url);
    }
  }

  const images = [...unique.values()];

  // Ưu tiên nhóm áo mặc định nếu xác định được.
  // Nếu không, chọn nhóm có ảnh front xuất hiện đầu tiên.
  const firstFront = images.find((url) => imageSide(url) === "front");

  const primaryKey =
    preferredGarment &&
    images.some((url) => garmentKey(url) === preferredGarment)
      ? preferredGarment
      : firstFront
        ? garmentKey(firstFront)
        : null;

  const originalOrder = new Map(images.map((url, index) => [url, index]));

  const priority = (url) => {
    const primary = primaryKey && garmentKey(url) === primaryKey;

    if (primary && imageSide(url) === "front") {
      return 0;
    }

    if (primary && imageSide(url) === "back") {
      return 1;
    }

    if (primary) return 2;

    return 3;
  };

  images.sort(
    (a, b) =>
      priority(a) - priority(b) || originalOrder.get(a) - originalOrder.get(b),
  );

  return {
    images,
    campaignId: id || null,
    primaryGarment: primaryKey,
  };
}

// Chạy Chrome trên Mac hoặc Chromium trên Vercel.
async function launchBrowser() {
  if (process.env.VERCEL) {
    const chromiumBinary = (await import("@sparticuz/chromium")).default;

    return chromium.launch({
      executablePath: await chromiumBinary.executablePath(),
      args: chromiumBinary.args,
      headless: true,
    });
  }

  return chromium.launch({
    channel: process.env.CHROME_EXECUTABLE_PATH ? undefined : "chrome",
    executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
}

// Kiểm tra chữ ký ảnh thay vì chỉ Content-Type.
function isImageBuffer(bytes) {
  if (!bytes || bytes.length < 12) return false;

  const text = (a, b) => bytes.toString("ascii", a, b);

  return (
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47) ||
    (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") ||
    (text(4, 8) === "ftyp" && ["avif", "avis"].includes(text(8, 12)))
  );
}

// Kiểm tra bản large có tồn tại hay không.
// Chỉ gửi request tới CDN Viralstyle cố định.
async function upgradeImageQuality(page, images) {
  const results = await Promise.all(
    images.map(async (original) => {
      try {
        const url = new URL(original);

        if (url.hostname !== ASSET || !url.pathname.startsWith("/campaigns/")) {
          return original;
        }

        if (/-large\./i.test(url.pathname)) {
          return original;
        }

        const large = new URL(original);

        large.pathname = large.pathname.replace(
          /-(small|medium|thumb)(?=\.(?:jpe?g|png|webp|avif)$)/i,
          "-large",
        );

        if (large.href === original) return original;

        const response = await page.request.get(large.href, {
          timeout: 4000,
          failOnStatusCode: false,
          maxRedirects: 0,
          headers: {
            Range: "bytes=0-63",
            Accept: "image/*,application/octet-stream",
          },
        });

        if (!response.ok()) return original;

        const bytes = await response.body();

        if (isImageBuffer(bytes)) {
          return large.href;
        }

        return original;
      } catch {
        return original;
      }
    }),
  );

  return results;
}

// Thu thập URL từ DOM, CSS và Network.
async function collectPageImages(page) {
  return page.evaluate(() => {
    const values = new Set();
    const hero = [];

    const push = (value) => {
      if (typeof value === "string" && value) {
        values.add(value);
      }
    };

    document
      .querySelectorAll("img,source,a,[data-src],[data-image]")
      .forEach((el) => {
        for (const attr of [
          "src",
          "href",
          "data-src",
          "data-image",
          "data-original",
          "data-background",
          "data-zoom-image",
        ]) {
          push(el.getAttribute(attr));
        }

        push(el.currentSrc);

        for (const attr of ["srcset", "data-srcset"]) {
          const value = el.getAttribute(attr) || "";

          for (const part of value.split(",")) {
            push(part.trim().split(/\s+/)[0]);
          }
        }
      });

    // Network resources.
    for (const entry of performance.getEntriesByType("resource")) {
      push(entry.name);
    }

    // CSS background-image.
    document.querySelectorAll("*").forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;

      if (!bg || bg === "none") return;

      for (const match of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) {
        push(match[1]);
      }
    });

    // URL nhúng trong HTML.
    const html = document.documentElement.outerHTML
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/");

    const regex =
      /https?:\/\/assets\.viralstyle\.com\/campaigns\/[a-z0-9/_\-.%]+?\.(?:jpe?g|png|webp|avif)/gi;

    for (const match of html.matchAll(regex)) {
      push(match[0]);
    }

    // Ảnh hiển thị trong khu vực sản phẩm.
    document
      .querySelectorAll(
        'main img,[class*="product"] img,[class*="gallery"] img',
      )
      .forEach((el) => {
        const url = el.currentSrc || el.src;

        if (url) hero.push(url);
      });

    return {
      values: [...values],
      hero,
    };
  });
}

// Chỉ nhận diện các control chọn kiểu áo.
async function getVariantControls(page) {
  return page.evaluate(() => {
    const results = [];

    const elements = document.querySelectorAll(
      [
        "select",
        '[role="combobox"]',
        '[class*="product-type"] button',
        '[class*="style-selector"] button',
        '[class*="garment"] button',
        '[class*="variant"] [role="option"]',
        '[class*="product-option"] button',
      ].join(","),
    );

    for (const el of elements) {
      const rect = el.getBoundingClientRect();

      if (!rect.width || !rect.height) continue;

      const text = (el.innerText || el.getAttribute("aria-label") || "").trim();

      const parentText = (el.parentElement?.innerText || "").slice(0, 160);

      const context = text + " " + parentText;

      if (
        /size|quantity|checkout|add to bag|add to cart|buy now|login|sign in/i.test(
          context,
        ) &&
        !/select style|hoodie|tee|sweatshirt|tank|jogger|shirt/i.test(context)
      ) {
        continue;
      }

      results.push({
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 80),
        className:
          typeof el.className === "string" ? el.className.slice(0, 120) : "",
      });
    }

    return results.slice(0, 40);
  });
}

export async function extractViralstyle(input) {
  const url = validPage(input);
  const browser = await launchBrowser();

  let context;
  let interactions = 0;
  let mainCampaign = null;
  let primaryGarment = null;

  const collected = new Set();

  const add = (raw) => {
    const image = campaignUrl(raw);

    if (image) {
      collected.add(image);
    }
  };

  try {
    context = await browser.newContext({
      viewport: {
        width: 1365,
        height: 900,
      },
      locale: "en-US",
    });

    const page = await context.newPage();

    page.setDefaultTimeout(3000);

    page.on("request", (request) => {
      add(request.url());
    });

    page.on("response", (response) => {
      add(response.url());
    });

    const response = await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (!response || response.status() >= 400) {
      throw new Error(`Viralstyle trả HTTP ${response?.status() || "unknown"}`);
    }

    // Chờ ảnh và JavaScript tải.
    await page.waitForTimeout(4500);

    async function collect() {
      const result = await collectPageImages(page);

      result.values.forEach(add);
      result.hero.forEach(add);

      // Xác định campaign chính từ ảnh sản phẩm.
      if (!mainCampaign) {
        const heroCampaign = result.hero.map(campaignUrl).find(Boolean);

        if (heroCampaign) {
          mainCampaign = campaignId(heroCampaign);
        }
      }

      // Dự phòng: campaign xuất hiện nhiều nhất.
      if (!mainCampaign && collected.size) {
        const counts = new Map();

        for (const image of collected) {
          const id = campaignId(image);

          counts.set(id, (counts.get(id) || 0) + 1);
        }

        mainCampaign = [...counts.entries()].sort(
          (a, b) => b[1] - a[1],
        )[0]?.[0];
      }

      // Ghi nhận nhóm ảnh đầu tiên của sản phẩm.
      if (!primaryGarment && mainCampaign) {
        const front = result.hero
          .map(campaignUrl)
          .find(
            (image) =>
              image &&
              campaignId(image) === mainCampaign &&
              imageSide(image) === "front",
          );

        if (front) {
          primaryGarment = garmentKey(front);
        }
      }
    }

    await collect();

    // Kích hoạt lazy loading.
    await page.evaluate(() => {
      window.scrollTo(0, Math.min(document.body.scrollHeight, 1200));
    });

    await page.waitForTimeout(700);
    await collect();

    // Tìm các nút chọn biến thể.
    const controls = await getVariantControls(page);

    console.log("VIRALSTYLE CONTROLS:", JSON.stringify(controls, null, 2));

    const selectors = [
      'select:not([name*="size" i])',
      '[class*="product-type"] button',
      '[class*="style-selector"] button',
      '[class*="garment"] button',
      '[class*="product-option"] button',
      '[class*="variant"] [role="option"]',
    ];

    for (const selector of selectors) {
      if (interactions >= MAX_VARIANTS) break;

      const locator = page.locator(selector);

      const count = Math.min(
        await locator.count().catch(() => 0),
        MAX_VARIANTS,
      );

      for (let i = 0; i < count; i++) {
        if (interactions >= MAX_VARIANTS) break;

        const control = locator.nth(i);

        try {
          if (!(await control.isVisible())) continue;

          const label = (await control.innerText().catch(() => "")).trim();

          if (
            /checkout|add to cart|add to bag|buy now|purchase|login|sign in|delete|remove/i.test(
              label,
            )
          ) {
            continue;
          }

          const tag = await control.evaluate((el) => el.tagName.toLowerCase());

          if (tag === "select") {
            const options = await control
              .locator("option")
              .evaluateAll((elements) =>
                elements
                  .filter(
                    (el) =>
                      el.value &&
                      !el.disabled &&
                      !/select|choose/i.test(el.textContent || ""),
                  )
                  .map((el) => el.value)
                  .slice(0, MAX_VARIANTS),
              );

            for (const value of options) {
              if (interactions >= MAX_VARIANTS) break;

              await control.selectOption(value);

              interactions++;

              await page.waitForTimeout(650);
              await collect();
            }
          } else {
            await control.click({
              timeout: 1500,
            });

            interactions++;

            await page.waitForTimeout(650);
            await collect();
          }
        } catch {
          // Control có thể render lại.
        }
      }
    }

    await collect();

    // Lọc theo campaign, ưu tiên ảnh đầu tiên.
    const normalized = normalizeUrls(
      [...collected],
      mainCampaign,
      primaryGarment,
    );

    // Thử nâng ảnh small/medium lên large.
    const highQuality = await upgradeImageQuality(
      page,
      normalized.images.slice(0, MAX_IMAGE_CHECKS),
    );

    // Loại URL trùng sau nâng cấp.
    const finalImages = [
      ...new Set([
        ...highQuality,
        ...normalized.images.slice(MAX_IMAGE_CHECKS),
      ]),
    ];

    return {
      page: input,
      finalUrl: page.url(),
      count: finalImages.length,
      images: finalImages,
      sources: ["Viralstyle Playwright Network + DOM + CSS"],
      note:
        `Campaign: ${
          normalized.campaignId || "không tìm thấy"
        }; đã thử ${interactions} thao tác biến thể. ` +
        "Đã ưu tiên ảnh large khi tồn tại. " +
        "Nhóm ảnh mặc định được xếp trước; " +
        "không bảo đảm đó luôn là T-shirt.",
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }

    await browser.close().catch(() => {});
  }
}
