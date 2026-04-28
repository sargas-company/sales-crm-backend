# Invoices API — документация для фронтенда

## Endpoints

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/invoices` | Создать инвойс |
| `GET` | `/invoices` | Список инвойсов (пагинация) |
| `GET` | `/invoices/:id` | Получить инвойс |
| `PATCH` | `/invoices/:id` | Обновить инвойс |
| `DELETE` | `/invoices/:id` | Удалить инвойс |
| `POST` | `/invoices/:id/generate` | Сгенерировать PDF |

---

## POST /invoices и PATCH /invoices/:id

Тело запроса одинаковое. При `PATCH` все поля опциональны — передавай только то, что изменилось.

### Обязательные поля

| Поле | Тип | Описание |
|---|---|---|
| `counterpartyId` | `string` (UUID) | ID контрагента из нашей БД |

### Основные поля инвойса

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `header` | `string` | `"INVOICE"` | Заголовок документа. Например: `"INVOICE"`, `"RECEIPT"`, `"CREDIT NOTE"` |
| `logoUrl` | `string` (URL) | `null` | URL логотипа компании |
| `number` | `string` | `null` | Номер инвойса. Например: `"INV-001"`, `"2026-042"` |
| `currency` | `string` (ISO 4217) | `"USD"` | Валюта. Например: `"USD"`, `"EUR"`, `"UAH"` |
| `date` | `string` (ISO 8601) | текущая дата | Дата инвойса. Формат: `"2026-04-22"` |
| `dueDate` | `string` (ISO 8601) | `null` | Срок оплаты. Формат: `"2026-05-22"`. Если не нужно — **не передавай поле вообще** или передай `undefined` (не пустую строку `""`) |
| `paymentTerms` | `string` | `null` | Условия оплаты. Например: `"NET 30"`, `"Due on receipt"` |
| `poNumber` | `string` | `null` | Номер заказа (Purchase Order). Например: `"PO-123"` |

### Адреса

| Поле | Тип | Описание |
|---|---|---|
| `fromValue` | `string` | Адрес отправителя (твоя компания). Многострочный — переносы через `\n`. Например: `"Sargas Agency OÜ\nHarju maakond, Tallinn"` |
| `toValue` | `string` | Адрес получателя (клиент). Многострочный через `\n` |
| `shipTo` | `string` | Адрес доставки. Многострочный через `\n` |

### Текстовые блоки

| Поле | Тип | Описание |
|---|---|---|
| `notes` | `string` | Примечания внизу инвойса. Например: `"Thank you for your business!"` |
| `terms` | `string` | Условия и положения. Например: `"Payment due within 30 days."` |

### Финансовые значения

Все числовые поля принимают `number >= 0`. Строки типа `"10"` тоже принимаются (бэкенд преобразует).

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `tax` | `number` | `0` | Сумма или процент налога. Например: `10` (10% если `showTax: "%"`, иначе $10) |
| `discounts` | `number` | `0` | Скидка. Например: `50` ($50 от суммы) |
| `shipping` | `number` | `0` | Стоимость доставки. Например: `15` |
| `amountPaid` | `number` | `0` | Уже оплачено. Например: `100` |

> **Важно:** Передавай `0` как `0`, а не пустую строку `""` или `null`. Если поле не нужно вообще — просто не включай его в запрос.

### Управление видимостью строк (show-флаги)

Эти флаги контролируют, **показывать ли строку** в PDF. Числовое значение (`tax`, `discounts` и т.д.) влияет на расчёт только если строка видима.

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `showTax` | `boolean` | `false` | `false` — скрыть строку налога; `true` — показать строку налога |
| `showDiscounts` | `boolean` | `false` | `true` — показать строку скидки |
| `showShipping` | `boolean` | `false` | `true` — показать строку доставки |
| `showShipTo` | `boolean` | `false` | `true` — показать блок адреса доставки |

**Пример:** налог $20 → `{ tax: 20, showTax: true }`  
**Пример:** налог скрыт → `{ showTax: false }` (значение `tax` не влияет на PDF)

### Кастомизация заголовков (labels)

Объект `labels` позволяет переименовать любую колонку или секцию в PDF. Все ключи опциональны.

```json
{
  "labels": {
    "to_title": "Bill To",
    "ship_to_title": "Ship To",
    "invoice_number_title": "Invoice #",
    "date_title": "Date",
    "payment_terms_title": "Payment Terms",
    "due_date_title": "Due Date",
    "purchase_order_title": "PO Number",
    "item_header": "Description",
    "quantity_header": "Qty",
    "unit_cost_header": "Price",
    "amount_header": "Total",
    "subtotal_title": "Subtotal",
    "discounts_title": "Discount",
    "tax_title": "VAT",
    "shipping_title": "Shipping",
    "amount_paid_title": "Amount Paid",
    "balance_title": "Balance Due",
    "notes_title": "Notes",
    "terms_title": "Terms & Conditions"
  }
}
```

Если не нужно переименовывать — передай пустой объект `{}` или не передавай поле вообще.

### Кастомные поля (customFields)

Массив дополнительных пар ключ-значение, которые выводятся в шапке инвойса.

```json
{
  "customFields": [
    { "name": "Project", "value": "Website Redesign" },
    { "name": "Account Number", "value": "CUST-456" }
  ]
}
```

Если нет — передай `[]` или не передавай поле.

### Позиции инвойса (lineItems)

Массив объектов. При обновлении (`PATCH`) **весь массив заменяется** — передавай все позиции, не только изменённые.

| Поле | Тип | Обязательность | Описание |
|---|---|---|---|
| `name` | `string` | опционально | Название позиции |
| `description` | `string` | опционально | Описание позиции |
| `quantity` | `number >= 0` | опционально | Количество. Строка `"1"` тоже принимается |
| `unitCost` | `number >= 0` | опционально | Цена за единицу. Строка `"99.99"` тоже принимается |
| `sortOrder` | `number >= 0` | опционально | Порядок отображения. `0` — первый |

---

## Полный пример тела запроса

```json
{
  "counterpartyId": "7aa7310e-cfa3-4efd-9205-c963ad3b42d4",
  "header": "INVOICE",
  "logoUrl": "https://sargas.io/logo.png",
  "number": "INV-042",
  "currency": "USD",
  "date": "2026-04-22",
  "dueDate": "2026-05-22",
  "paymentTerms": "NET 30",
  "poNumber": "PO-123",
  "fromValue": "Sargas Agency OÜ\nHarju maakond, Tallinn\nNarva mnt 7, 10117",
  "toValue": "Acme Corp\n123 Client Street\nNew York, NY 10001",
  "shipTo": "456 Warehouse Rd\nBrooklyn, NY 11201",
  "notes": "Thank you for your business!",
  "terms": "Payment due within 30 days.",
  "tax": 8,
  "discounts": 0,
  "shipping": 15,
  "amountPaid": 0,
  "showTax": true,
  "showDiscounts": false,
  "showShipping": true,
  "showShipTo": true,
  "labels": {
    "tax_title": "VAT",
    "due_date_title": "Due Date"
  },
  "customFields": [
    { "name": "Project", "value": "Website Redesign" }
  ],
  "lineItems": [
    {
      "name": "Web Development",
      "description": "Frontend + backend implementation",
      "quantity": 16,
      "unitCost": 87.50,
      "sortOrder": 0
    },
    {
      "name": "Design",
      "quantity": 8,
      "unitCost": 50,
      "sortOrder": 1
    }
  ]
}
```

---

## Частые ошибки

| Ошибка | Причина | Решение |
|---|---|---|
| `tax must be a number` | Передано `""` или `null` | Передавай `0` или не включай поле |
| `dueDate` — Invalid Date | Передана пустая строка `""` | Не включай поле если дата не выбрана |
| `lineItems.0.quantity must be a number` | Передана строка `""` | Передавай `0` или не включай поле |
| Позиции не обновились | При PATCH передан неполный массив | Передавай **все** позиции, не только изменённые |
