exports.stagesOf = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
exports.money = (n) => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')} ₫`;
