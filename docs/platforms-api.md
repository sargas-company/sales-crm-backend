# Platforms — API Reference

Платформи — глобальні сутності (не прив'язані до конкретного юзера). Використовуються при створенні акаунтів і пропозалів.

За замовчуванням є дві платформи, заповнені при ініціалізації БД:

| ID | Title | Slug |
|----|-------|------|
| `00000000-0000-0000-0000-000000000001` | Upwork | `upwork` |
| `00000000-0000-0000-0000-000000000002` | LinkedIn | `linkedin` |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/platforms` | Create a platform |
| `GET` | `/platforms` | Get all platforms |
| `GET` | `/platforms/:id` | Get platform by ID |
| `PUT` | `/platforms/:id` | Update platform |
| `DELETE` | `/platforms/:id` | Delete platform |

All endpoints require `Authorization: Bearer <token>`.

---

## GET /platforms

Повертає список всіх платформ, відсортованих за назвою.

### Response

```json
[
  {
    "id": "00000000-0000-0000-0000-000000000001",
    "title": "Upwork",
    "slug": "upwork",
    "imageUrl": "https://example.com/upwork.png",
    "createdAt": "2026-04-16T00:00:00Z",
    "updatedAt": "2026-04-16T00:00:00Z"
  },
  {
    "id": "00000000-0000-0000-0000-000000000002",
    "title": "LinkedIn",
    "slug": "linkedin",
    "imageUrl": null,
    "createdAt": "2026-04-16T00:00:00Z",
    "updatedAt": "2026-04-16T00:00:00Z"
  }
]
```

---

## POST /platforms

### Request Body

```json
{
  "title": "Upwork",
  "slug": "upwork",
  "imageUrl": "https://example.com/upwork.png"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | **yes** | Відображувана назва платформи |
| `slug` | `string` | **yes** | Унікальний ідентифікатор (lowercase, через дефіс). Використовується для пошуку дефолту |
| `imageUrl` | `string` | no | URL логотипу/іконки платформи. Оновлення тут автоматично оновлює відображення у всіх акаунтах |

> `slug` повинен бути унікальним. При дублікаті повертає `409 Conflict`.

### Response — `201 Created`

```json
{
  "id": "uuid",
  "title": "Upwork",
  "slug": "upwork",
  "imageUrl": "https://example.com/upwork.png",
  "createdAt": "2026-04-16T12:00:00Z",
  "updatedAt": "2026-04-16T12:00:00Z"
}
```

---

## PUT /platforms/:id

Всі поля опціональні.

```json
{
  "imageUrl": "https://example.com/new-upwork-logo.png"
}
```

> Зміна `imageUrl` тут відображається у всіх акаунтів, прив'язаних до цієї платформи — через relation (не копіюється).

---

## DELETE /platforms/:id

Повертає `204 No Content`.

> **Увага:** не можна видалити платформу, до якої прив'язані акаунти — бекенд поверне `500`. Спочатку треба перенести або видалити акаунти.

---

## Notes

- Список платформ зазвичай завантажується один раз при старті фронтенду і кешується.
- При створенні акаунту або пропозалу — передавати `platformId` (UUID), отриманий з `GET /platforms`.
- Оновлення `imageUrl` на платформі достатньо — логотип підтягнеться скрізь через relation.
