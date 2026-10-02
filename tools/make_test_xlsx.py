"""Генерирует тестовый Excel: python tools/make_test_xlsx.py N out.xlsx [--errors]"""
import random
import sys

from openpyxl import Workbook

n = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
out = sys.argv[2] if len(sys.argv) > 2 else "test.xlsx"
with_errors = "--errors" in sys.argv
random.seed(42)
types = ["Вышка связи", "Офис", "Склад", "Инцидент"]
wb = Workbook(write_only=True)
ws = wb.create_sheet("Объекты")
ws.append(["ID", "Тип", "Название", "Широта", "Долгота", "Адрес", "Радиус, м", "Описание", "Ответственный", "Телефон"])
for i in range(1, n + 1):
    lat = 55.75 + random.gauss(0, 0.6)
    lon = 37.62 + random.gauss(0, 1.0)
    t = random.choice(types)
    radius = random.choice([None, None, 300, 500, 1000, 2000]) if t in ("Вышка связи", "Склад", "Инцидент") else None
    row = [f"OBJ-{i:06d}", t, f"{t} № {i}", round(lat, 6), round(lon, 6), f"Адрес {i}", radius, "",
           random.choice(["Иванов", "Петров", "Сидорова"]), f"+7 900 {i:07d}"]
    if with_errors and i % 50 == 0:
        row[3] = "abc"
    if with_errors and i % 77 == 0:
        row[1] = "Неизвестно"
    if with_errors and i % 101 == 0:
        row[3], row[4] = row[4], row[3]
    ws.append(row)
wb.save(out)
print(out)
