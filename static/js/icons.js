// Встроенные иконки (сетка 24×24) и отрисовка маркера-«капли» в цвете типа.

export const ICONS = {
  circle: 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0 -14 0z',
  square: 'M6 6h12v12H6z',
  triangle: 'M12 4l9 16H3z',
  diamond: 'M12 3l9 9-9 9-9-9z',
  star: 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z',
  plus: 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z',
  hexagon: 'M7 3.5h10l5 8.5-5 8.5H7L2 12z',
  flag: 'M5 3h2v18H5zM8 4h11l-3 4.5L19 13H8z',
  house: 'M12 3l10 9h-3v8h-5v-6h-4v6H5v-8H2z',
  tower: 'M10 2h4v4h-4zM11 7h2l5 15h-2.3l-1.2-4h-5l-1.2 4H6zM10.2 16h3.6L12 10.3z',
  drop: 'M12 2.5C12 2.5 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-7-12.5-7-12.5z',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
  warning: 'M12 2L1 21h22zM11 9h2v6h-2zM11 16.5h2v2h-2z',
  tree: 'M12 2l6 8h-3l4 6h-6v6h-2v-6H5l4-6H6z',
  car: 'M5 11l2-5h10l2 5h1v6h-2v2h-3v-2H9v2H6v-2H4v-6zM7.5 11h9l-1.2-3H8.7zM6 13h2v2H6zM16 13h2v2h-2z',
  factory: 'M2 21V10l6 4V10l6 4V10l6 4V3h2v18z',
};

export const ICON_NAMES = {
  circle: 'Круг', square: 'Квадрат', triangle: 'Треугольник', diamond: 'Ромб', star: 'Звезда', plus: 'Крест',
  hexagon: 'Шестиугольник', flag: 'Флаг', house: 'Здание', tower: 'Вышка', drop: 'Капля', bolt: 'Молния',
  warning: 'Внимание', tree: 'Дерево', car: 'Транспорт', factory: 'Завод',
};

const W = 30;
const H = 40;
const SCALE = 2;
const imageCache = new Map();

export function iconUrl(icon) {
  return icon.startsWith('upload:') ? `/api/icons/file/${encodeURIComponent(icon.slice(7))}` : null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function pinPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(15, 38.5);
  ctx.bezierCurveTo(13, 34, 3, 25, 3, 14);
  ctx.arc(15, 14, 12, Math.PI, 0);
  ctx.bezierCurveTo(27, 25, 17, 34, 15, 38.5);
  ctx.closePath();
}

/** Холст 60×80 (pixelRatio 2) с маркером типа. */
export async function markerCanvas(type) {
  const key = `${type.icon}|${type.color}`;
  if (imageCache.has(key)) return imageCache.get(key);
  const promise = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    pinPath(ctx);
    ctx.fillStyle = type.color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    const url = iconUrl(type.icon);
    if (url) {
      try {
        const img = await loadImage(url);
        ctx.save();
        ctx.beginPath();
        ctx.arc(15, 14, 9.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.clip();
        ctx.drawImage(img, 7, 6, 16, 16);
        ctx.restore();
      } catch { /* иконка недоступна — остаётся пустая капля */ }
    } else {
      ctx.save();
      ctx.translate(7.5, 6.5);
      ctx.scale(15 / 24, 15 / 24);
      ctx.fillStyle = '#ffffff';
      ctx.fill(new Path2D(ICONS[type.icon] || ICONS.circle), 'evenodd');
      ctx.restore();
    }
    return canvas;
  })();
  imageCache.set(key, promise);
  return promise;
}

export async function markerDataUrl(type) {
  return (await markerCanvas(type)).toDataURL('image/png');
}

/** Небольшая SVG-иконка без капли — для списков выбора. */
export function glyphSvg(icon, color = 'currentColor', size = 20) {
  const url = iconUrl(icon);
  if (url) return `<img src="${url}" width="${size}" height="${size}" alt="">`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="${color}" fill-rule="evenodd" d="${ICONS[icon] || ICONS.circle}"/></svg>`;
}
