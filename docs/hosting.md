# Внешний доступ для Beta

Гостевой режим работает без Supabase: нужен только статический HTTPS хостинг. Публикуется содержимое production `dist`, не исходники и не dev server. Данные объектов хранятся в браузере устройства; размещение сайта само по себе не включает синхронизацию.

## Cloudflare Pages: загрузка готового ZIP

1. Войдите в свой Cloudflare аккаунт, откройте Workers & Pages и создайте Pages-проект через загрузку готовых файлов (Direct Upload / Upload assets).
2. Загрузите подготовленный `artifacts/zamer-beta-site.zip` целиком. В корне архива находятся index.html, assets, sw.js, manifest и правила хостинга. Укажите свободное имя проекта и выполните Deploy.
3. Откройте выданный Cloudflare HTTPS адрес `https://<имя-проекта>.pages.dev`. Это шаблон, фактический адрес выдаёт хостинг после публикации.
4. На главной создайте гостевой объект. На телефоне открывайте тот же адрес. Объект с компьютера переносится через полный ZIP/импорт, пока Supabase не подключён.

Смена домена, браузера или профиля создаёт отдельное локальное хранилище. До смены адреса экспортируйте полный ZIP на диск; не очищайте данные сайта без проверенной копии. Временный адрес туннеля непригоден для постоянного хранения объектов, поскольку адрес может измениться.

В этой cloud-среде Cloudflare endpoints получили HTTP 403 от сетевого прокси, готовой hosting-auth привязки нет. Пакет подготовлен и проверен локально; внешняя публикация и проверка адреса остаются открытыми. Токены и пароли не отправляйте в чат. Для автоматической публикации потребуется доступ к выбранному хостингу через безопасные настройки окружения.

## Повторная сборка

```sh
cd /workspace/zamer-app
npm ci --cache /workspace/.npm-cache
npm run build
python - <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
dist = Path('dist')
Path('artifacts').mkdir(exist_ok=True)
with ZipFile('artifacts/zamer-beta-site.zip', 'w', ZIP_DEFLATED) as archive:
    for path in sorted(dist.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(dist).as_posix())
PY
```

Vite копирует `public/_headers` и `_redirects` в dist. Правила обновляют HTML/service worker/manifest без длительного кеша и кешируют assets с hash на год. Маршруты `/projects/*` возвращают index.html, чтобы перезагрузка страницы плана работала. Cloudflare Pages также поддерживает SPA fallback, когда отсутствует 404.html. Проверка реальных response headers выполняется после deploy.

Для Git-интеграции: Node 24, команда сборки `npm ci && npm run build`, output `dist`. `wrangler.toml` закрепляет Pages-проект `zamer-studio` и `pages_build_output_dir="./dist"`; конфигурация репозитория является источником настроек. Если Pages-проект называется иначе, поменяйте name в wrangler.toml перед размещением в нём. Для Git-интеграции в main должны быть отправлены package.json, package-lock.json, index.html, src, public, конфигурация сборки и .node-version (Node 24). Ошибка ENOENT package.json означает, что Cloudflare скачал неполный репозиторий. После отправки полного кода повторите deployment для свежего commit. Direct Upload использует готовую сборку и не требует push. Не добавляйте автоматически workflow с незаданными credentials.

Когда подключите Supabase, задайте публичные `VITE_SUPABASE_URL` и `VITE_SUPABASE_PUBLISHABLE_KEY` при сборке, пересоберите сайт и настройте Auth redirect для его адреса по [инструкции](supabase-setup.md). Service role в браузер не добавлять.

## Публикация из облачной среды

Если хотите, чтобы размещение выполнил агент, вместо ручной загрузки задайте в защищённых настройках окружения `CLOUDFLARE_API_TOKEN` с правом Account / Cloudflare Pages / Edit для нужного аккаунта, `CLOUDFLARE_ACCOUNT_ID` и `CLOUDFLARE_PAGES_PROJECT`. Токен не вводите в чат. В черновике среды подготовлены требования к этим переменным и разрешённым доменам; сохранение черновика само по себе не применяет сеть и не публикует сайт.

После применения настроек сначала повторить read-only запрос к Cloudflare API и проверить аутентификацию, не выводя токен. Если указанный Pages-проект ещё не существует, создать его для ветки main через официальную CLI, затем загрузить dist. Используется Wrangler 4.148.0, установленный отдельно от зависимостей приложения. Поддержку CLI проверили командой help; фактические auth/create/deploy ещё не выполнялись.

```sh
cd /workspace/zamer-app
# Только если Pages-проект ещё не создан:
WRANGLER_SEND_METRICS=false npm exec --yes --cache /workspace/.npm-cache --package=wrangler@4.148.0 -- wrangler pages project create "$CLOUDFLARE_PAGES_PROJECT" --production-branch main
# Готовая production сборка:
WRANGLER_SEND_METRICS=false npm exec --yes --cache /workspace/.npm-cache --package=wrangler@4.148.0 -- wrangler pages deploy dist --project-name "$CLOUDFLARE_PAGES_PROJECT" --branch main
```

Не менять существующий проект с другим назначением. Полученный deployment URL проверять реальными HTTPS запросами и браузером до передачи пользователю. Публикация snapshot облачной среды и deployment Cloudflare Pages — разные действия.

## Проверка после deploy

- Главная открывается по HTTPS, нет ошибок загрузки scripts/fonts/icons.
- Создать объект и помещение; перезагрузить адрес `/projects/.../floors/...`: план открывается, размеры сохранены.
- Дождаться активации PWA, отключить сеть, перезагрузить и изменить замер; после повторного открытия правка сохранена.
- Скачать PDF/XLSX/ZIP, импортировать ZIP отдельным объектом, проверить фото и цены.
- Проверить обновление service worker: предыдущие документы/замеры сохраняются. Не удалять старый deployment, пока открытые клиенты ещё запрашивают его lazy chunks.

Результаты записываются в [протокол Beta](beta-acceptance.md). Наличие HTTPS адреса не закрывает критерии публичного выпуска из [матрицы](release-readiness.md).
