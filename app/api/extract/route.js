import { extractOne } from '../../../lib/extract.js';
import { extractViralstyle } from '../../../lib/extract-viralstyle.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request) {
  try {
    const body = await request.json();
    const mode = body.mode || 'normal';
    if (!['normal', 'viralstyle'].includes(mode)) {
      return Response.json({ error: 'Chế độ không hợp lệ' }, { status: 400 });
    }
    if (!Array.isArray(body.urls)) {
      return Response.json({ error: 'Thiếu danh sách URL' }, { status: 400 });
    }
    const urls = [...new Set(body.urls.map(x => String(x).trim()).filter(Boolean))];
    const limit = mode === 'viralstyle' ? 3 : 10;
    if (!urls.length || urls.length > limit) {
      return Response.json({ error: `Nhập 1–${limit} URL mỗi lượt trong chế độ này` }, { status: 400 });
    }
    const results = [];
    for (const url of urls) {
      try {
        results.push(await (mode === 'viralstyle' ? extractViralstyle(url) : extractOne(url)));
      } catch (e) {
        results.push({ page: url, count: 0, images: [], error: e?.message || 'Không lấy được ảnh' });
      }
    }
    return Response.json({ results, mode });
  } catch (error) {
    console.error('Extract route error:', error);
    return Response.json({ error: 'Lỗi xử lý yêu cầu' }, { status: 500 });
  }
}
