# VITrade

Личный стенд бумажной торговли DCA-ботами по живым ценам Bybit. Реальные ордера не отправляются.

## Запуск

```
npm install
npm run build
npm start            # http://127.0.0.1:4180
```

Импорт счетов из VITrade 0.1.0 (старая база открывается только на чтение):

```
npm run import -- "D:/Project/VITrade-run/.../VITrade/data/vitrade.sqlite"
```

Разработка интерфейса: `npm start` в одном окне, `npm run dev` в другом (http://localhost:5173).
Тесты движка: `npm test`.

## Публичный тест на Render

`render.yaml` описывает сервис: план Starter (не засыпает), регион Frankfurt, диск 1 ГБ в `/var/data` под базу,
проверка здоровья `/api/health`. На Render сервер слушает `0.0.0.0:$PORT`, принимает POST только со своего
адреса `RENDER_EXTERNAL_URL`, ставит cookie с флагом Secure и берёт IP клиента из `x-forwarded-for`.
`VITRADE_MAX_USERS` ограничивает число регистраций (0 — без ограничения).

## Устройство

- `server/engine` — учёт позиции, сетка докупок, тейк и стоп, подушка маржи, фандинг, команды бота; сигналы RSI и стадий памп-цикла.
- `server/market` — публичные данные биржи (сейчас Bybit).
- `server/net.js` — сетевая политика: наружу только GET к перечисленным адресам рыночных данных.
- `server/runner.js` — раз в секунду продвигает счета, раз в 5 секунд обновляет рынок.
- `server/http.js` — API и раздача интерфейса; локально слушает только 127.0.0.1, POST принимаются только со своего адреса.
- `web/` — интерфейс (React + Vite).

План развития — `D:\Project\crypto-bot\docs\dstrade_functional_map.md`.
