"use client";
import { useState } from "react";

export default function Home() {
  const [mode, setMode] = useState("normal");
  const [input, setInput] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const urls = input
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const limit = mode === "viralstyle" ? 3 : 10;

  async function run() {
    setLoading(true);
    setError("");
    setResults([]);
    try {
      const r = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, urls }),
      });
      const raw = await r.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          `API trả HTML hoặc phản hồi không hợp lệ (HTTP ${r.status})`,
        );
      }
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setResults(data.results || []);
    } catch (e) {
      setError(e.message || "Có lỗi xảy ra");
    } finally {
      setLoading(false);
    }
  }
  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Không thể copy; hãy dùng HTTPS hoặc localhost");
    }
  }
  function download() {
    const rows = [
      ["Product URL", "Image count", "Image URLs", "Error"],
      ...results.map((x) => [
        x.page,
        x.count,
        (x.images || []).join(","),
        x.error || "",
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"')
          .join(","),
      )
      .join("\r\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    a.href = objectUrl;
    a.download = `pod-images-${mode}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  return (
    <main>
      <header>
        <div className="logo">◈ POD Image Tool</div>
        <span className="tag">Leemintri</span>
      </header>
      <section className="hero">
        <h1>Lấy link hình ảnh sản phẩm</h1>
        <p>
          Chọn chế độ, dán danh sách link và xuất URL ảnh cách nhau bằng dấu
          phẩy.
        </p>
      </section>
      <section className="panel">
        <h2>Chọn chế độ</h2>
        <div className="modeGrid">
          <button
            type="button"
            className={"modeButton " + (mode === "normal" ? "selected" : "")}
            onClick={() => {
              setMode("normal");
              setResults([]);
            }}
          >
            🛍 Website thường<small>Gallery HTML, Shopify, WooCommerce</small>
          </button>
          <button
            type="button"
            className={
              "modeButton " + (mode === "viralstyle" ? "selected" : "")
            }
            onClick={() => {
              setMode("viralstyle");
              setResults([]);
            }}
          >
            ⚡ Viralstyle<small>Chromium, Network, ảnh campaign</small>
          </button>
        </div>
        <label htmlFor="urls">
          Danh sách URL{" "}
          <span>(mỗi dòng một link, tối đa {limit} link/lượt)</span>
        </label>
        <textarea
          id="urls"
          rows="7"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            mode === "viralstyle"
              ? "https://viralstyle.com/atdh/nyl665"
              : "https://example.com/products/shirt"
          }
        />
        <div className="actions">
          <span>{urls.length} link</span>
          <button
            disabled={loading || !urls.length || urls.length > limit}
            onClick={run}
          >
            {loading ? "Đang mở trang và lấy ảnh..." : "Lấy URL hình ảnh →"}
          </button>
        </div>
        {mode === "viralstyle" && (
          <p className="hint">
            Chế độ Chromium xử lý tối đa 3 link/lượt để giảm nguy cơ timeout
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>
      {results.length > 0 && (
        <section className="panel">
          <div className="resultHead">
            <h2>Kết quả ({results.length} sản phẩm)</h2>
            <div className="buttons">
              <button
                className="secondary"
                onClick={() =>
                  copy(
                    results.map((x) => (x.images || []).join(",")).join("\n"),
                  )
                }
              >
                Copy tất cả
              </button>
              <button onClick={download}>Xuất CSV</button>
            </div>
          </div>
          {results.map((r, i) => (
            <article key={i}>
              <div className="resultTitle">
                <strong>
                  Sản phẩm {i + 1} · {r.count || 0} ảnh
                </strong>
                <button
                  className="secondary small"
                  disabled={!r.count}
                  onClick={() => copy((r.images || []).join(","))}
                >
                  Copy dòng này
                </button>
              </div>
              <a href={r.page} target="_blank" rel="noreferrer">
                {r.page}
              </a>
              {r.error ? (
                <p className="error">{r.error}</p>
              ) : (
                <>
                  <div className="thumbs">
                    {(r.images || []).slice(0, 12).map((u, j) => (
                      <img
                        key={j}
                        src={u}
                        alt={"Ảnh sản phẩm " + (j + 1)}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ))}
                  </div>
                  <textarea
                    readOnly
                    rows="4"
                    value={(r.images || []).join(",")}
                  />
                  {r.note && <p className="hint">{r.note}</p>}
                </>
              )}
            </article>
          ))}
        </section>
      )}
      <footer>
        Chỉ sử dụng với trang công khai mà bạn có quyền truy cập. Công cụ xuất
        URL, không lưu file ảnh.
      </footer>
    </main>
  );
}
