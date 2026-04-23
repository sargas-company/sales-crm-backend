# Accounts — API Reference

Акаунт — профіль девелопера на конкретній платформі (наприклад, Dmytro Sarafaniuk на Upwork). Прив'язаний до залогіненого юзера. Один юзер може мати **один акаунт на кожній платформі**.

При створенні пропозалу обов'язково обирається акаунт (`accountId`), від імені якого подається пропозал.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/accounts` | Create an account |
| `GET` | `/accounts` | Get all accounts for current user |
| `GET` | `/accounts/:id` | Get account by ID |
| `PUT` | `/accounts/:id` | Update account |
| `DELETE` | `/accounts/:id` | Delete account |

All endpoints require `Authorization: Bearer <token>`.

---

## GET /accounts

Повертає всі акаунти залогіненого юзера, відсортовані за `lastName`, потім `firstName`.

### Response

```json
[
  {
    "id": "uuid",
    "firstName": "Dmytro",
    "lastName": "Sarafaniuk",
    "platformId": "00000000-0000-0000-0000-000000000001",
    "userId": "uuid",
    "createdAt": "2026-04-16T12:00:00Z",
    "updatedAt": "2026-04-16T12:00:00Z",
    "platform": {
      "id": "00000000-0000-0000-0000-000000000001",
      "title": "Upwork",
      "slug": "upwork",
      "imageUrl": "https://example.com/upwork.png",
      "createdAt": "2026-04-16T00:00:00Z",
      "updatedAt": "2026-04-16T00:00:00Z"
    }
  }
]
```

---

## POST /accounts

### Request Body

```json
{
  "firstName": "Dmytro",
  "lastName": "Sarafaniuk",
  "platformId": "00000000-0000-0000-0000-000000000001"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `firstName` | `string` | **yes** | Ім'я девелопера |
| `lastName` | `string` | **yes** | Прізвище девелопера |
| `platformId` | `string` (UUID) | **yes** | ID платформи з `GET /platforms` |

> На одній платформі можна мати тільки один акаунт. При спробі створити дублікат повертає `409 Conflict`.

### Response — `201 Created`

```json
{
  "id": "uuid",
  "firstName": "Dmytro",
  "lastName": "Sarafaniuk",
  "platformId": "00000000-0000-0000-0000-000000000001",
  "userId": "uuid",
  "createdAt": "2026-04-16T12:00:00Z",
  "updatedAt": "2026-04-16T12:00:00Z",
  "platform": {
    "id": "00000000-0000-0000-0000-000000000001",
    "title": "Upwork",
    "slug": "upwork",
    "imageUrl": "https://example.com/upwork.png"
  }
}
```

---

## PUT /accounts/:id

Всі поля опціональні.

```json
{
  "firstName": "Dmytro",
  "lastName": "S.",
  "platformId": "00000000-0000-0000-0000-000000000002"
}
```

> При зміні `platformId` — перевіряється, що акаунт на новій платформі ще не існує.

---

## DELETE /accounts/:id

Повертає `204 No Content`.

---

## Типовий флоу

```
1. GET /platforms              → отримати список платформ і їх ID
2. POST /accounts              → створити акаунт (firstName, lastName, platformId)
3. GET /accounts               → отримати список акаунтів для вибору у формі пропозалу
4. POST /proposals             → створити пропозал з accountId + platformId
```

---

## Notes

- Акаунти бачить тільки їх власник — юзер отримує тільки свої акаунти.
- Картинка акаунту береться з `platform.imageUrl` — не зберігається окремо на акаунті.
- На фронті при виборі акаунту в формі пропозалу рекомендується автоматично підставляти `platformId` з `account.platform.id`.
