import { chromium } from "playwright";
import notifier from "node-notifier";
import { config } from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

config();

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const INTERVAL = parseInt(process.env.CHECK_INTERVAL_MINUTES || "30", 10);
const TARGET = process.env.TARGET_HOUSING || "コーシャタワー佃";
const ONCE = process.argv.includes("--once");
const DEBUG = process.argv.includes("--debug");

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
const STATE_FILE = path.join(__dirname, "state.json");
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR);

const START_URL =
  "https://jhomes.to-kousya.or.jp/search/jkknet/service/akiyaJyokenDirect";

function ts() {
  return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// 前回「空室あり」だったかを記録（毎回通知してスパムにしないため）
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { wasAvailable: false };
  }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- LINE Messaging API（Bot友だち全員=自分にブロードキャスト）---
async function sendLine(text) {
  if (!LINE_TOKEN) {
    log("LINEトークン未設定のため、LINE通知はスキップ");
    return;
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ type: "text", text }],
      }),
    });
    if (res.ok) {
      log("LINE通知を送信しました");
    } else {
      const body = await res.text();
      log(`LINE通知エラー (${res.status}): ${body}`);
    }
  } catch (e) {
    log(`LINE通知エラー: ${e.message}`);
  }
}

function desktopNotify(title, message) {
  try {
    notifier.notify({ title, message, sound: true, wait: false });
  } catch {}
}

// 中継ページ群を辿って先着順あき家の検索結果ページに到達する
async function reachResults(page) {
  await page.goto(START_URL, { waitUntil: "networkidle", timeout: 60000 });

  // forwardForm（中継）が残っている間は送信して進める（最大5回）
  for (let i = 0; i < 5; i++) {
    const isRelay = await page.evaluate(() => {
      const f = document.forms["forwardForm"];
      return !!(f && f.elements["redirect"]);
    });
    if (!isRelay) break;

    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      page.evaluate(() => {
        const f = document.forms["forwardForm"];
        if (f) {
          f.target = ""; // 別ウィンドウではなく同じページで遷移
          f.action = f.elements["url"].value;
          f.submit();
        }
      }),
    ]);
    await page.waitForTimeout(2000);
  }
}

async function checkVacancy() {
  log(`=== ${TARGET} 空室チェック開始 ===`);

  const browser = await chromium.launch({ headless: !DEBUG });
  const context = await browser.newContext({
    locale: "ja-JP",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await reachResults(page);

    // 表示件数を50件にして全件を1ページに（取りこぼし防止）
    const showCount = page.locator('select[name="akiyaRefRM.showCount"]');
    if ((await showCount.count()) > 0) {
      await showCount.selectOption("50").catch(() => {});
      await page.waitForTimeout(2000);
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    const bodyText = await page.innerText("body").catch(() => "");

    // 検索結果ページに本当に到達できているかの健全性チェック
    const onResultPage =
      bodyText.includes("先着順あき家") || bodyText.includes("該当しました");
    if (!onResultPage) {
      log("検索結果ページに到達できませんでした（サイト構造変更の可能性）");
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `UNEXPECTED_${Date.now()}.png`),
      });
      await browser.close();
      return null;
    }

    // 全ページを走査（50件/ページでも念のため次ページがあれば辿る）
    let fullText = bodyText;
    for (let p = 0; p < 10; p++) {
      const nextBtn = page.locator(
        'a:has-text("後ろへ"), a:has-text("次へ"), a:has-text(">>")'
      );
      const hasNext =
        (await nextBtn.count()) > 0 &&
        (await nextBtn.first().isEnabled().catch(() => false));
      if (!hasNext) break;
      const before = page.url();
      await nextBtn.first().click().catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1500);
      const more = await page.innerText("body").catch(() => "");
      if (more && more !== before) fullText += "\n" + more;
      else break;
    }

    // 全角・半角スペースを除去してから照合（「コーシャタワー　佃」等の表記ゆれ対策）。
    // 「コーシャタワー」だけの広すぎる一致はしない（佃以外のコーシャタワーに誤反応するため）
    const normalize = (s) => s.replace(/[\s　]/g, "");
    const found = normalize(fullText).includes(normalize(TARGET));

    const state = loadState();

    if (found) {
      log(`★★★ ${TARGET} に空室があります！ ★★★`);
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `FOUND_${Date.now()}.png`),
        fullPage: true,
      });

      // 前回も「あり」だった場合は再通知しない（スパム防止）
      if (!state.wasAvailable) {
        const message =
          `🏠【空室速報】${TARGET} に空きが出ました！\n` +
          `先着順です。今すぐ申込手続きを！\n\n` +
          `▼ JKKねっと 先着順あき家検索\n${START_URL}\n\n` +
          `(検知時刻: ${ts()})`;
        desktopNotify("JKK空室速報！", `${TARGET} に空きが出ました！`);
        await sendLine(message);
      } else {
        log("（前回も空室ありのため再通知はスキップ）");
      }

      saveState({ wasAvailable: true, lastFound: ts() });
      await browser.close();
      return true;
    }

    log(`${TARGET} の空室: なし`);
    saveState({ wasAvailable: false, lastChecked: ts() });
    await browser.close();
    return false;
  } catch (error) {
    log(`エラー: ${error.message}`);
    try {
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `ERROR_${Date.now()}.png`),
      });
    } catch {}
    await browser.close();
    return null;
  }
}

async function main() {
  log("=== JKK 先着順あき家 自動チェッカー ===");
  log(`対象住宅: ${TARGET}`);
  log(`チェック間隔: ${INTERVAL}分`);
  log(`LINE通知: ${LINE_TOKEN ? "有効" : "無効（LINE_CHANNEL_ACCESS_TOKEN未設定）"}`);
  log(`デスクトップ通知: 有効`);
  log("");

  if (ONCE) {
    const r = await checkVacancy();
    // 空室あり/なしはどちらも正常終了(0)。エラー(null)のみ異常終了(1)
    process.exit(r === null ? 1 : 0);
  }

  await checkVacancy();
  log(`\n${INTERVAL}分おきに自動チェックします（停止: Ctrl+C）\n`);
  setInterval(async () => {
    await checkVacancy();
    log(`次回チェック: ${INTERVAL}分後\n`);
  }, INTERVAL * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
