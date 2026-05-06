# 夺冠之路：女排精神中的马原密码

这是一个用于大一《马克思主义基本原理》课堂汇报的实时互动小游戏。大屏端打开 `/screen`，手机端扫码进入 `/vote`，同学无需登录即可投票。项目已从本地 Express + Socket.IO 原型改造成可部署到 Vercel 的 React + Vite + Supabase Realtime 公网版。

大屏和手机不需要在同一个 Wi-Fi。只要大屏电脑和学生手机都能访问同一个 Vercel HTTPS 地址，手机用校园网或流量都可以参与。

## 项目页面

- `/screen`：大屏展示页，同时包含主持人控制面板。
- `/vote`：手机投票页，扫码后直接投票。
- 剧情内容：`src/gameData.js`
- UI 样式：`src/styles.css`

## 本地运行

```bash
npm install
npm run dev
```

本地访问：

```text
http://localhost:5173/screen
http://localhost:5173/vote
```

本地调试需要在项目根目录创建 `.env.local`：

```env
VITE_SUPABASE_URL=你的 Supabase Project URL
VITE_SUPABASE_ANON_KEY=你的 Supabase anon public key
VITE_HOST_PIN=2026
```

## 1. Supabase 建表和 Realtime 配置

### 创建 Supabase 项目

1. 打开 [Supabase](https://supabase.com/) 并创建一个新项目。
2. 进入项目后，打开 `Project Settings -> API`。
3. 复制 `Project URL`，作为 `VITE_SUPABASE_URL`。
4. 复制 `anon public` key，作为 `VITE_SUPABASE_ANON_KEY`。
5. 不要使用 `service_role` key。`service_role` 权限过高，不能放在前端或 Vercel 环境变量里。

### 执行建表 SQL

进入 `SQL Editor`，新建 query，粘贴并运行下面的 SQL：

```sql
create extension if not exists pgcrypto;

create table if not exists public.game_state (
  id text primary key default 'main',
  phase text not null default 'cover'
    check (phase in ('cover', 'briefing', 'voting', 'locked', 'final')),
  round_index integer not null default -1,
  round_id text,
  route text[] not null default '{}',
  voting_open boolean not null default false,
  voting_locked boolean not null default false,
  leader text check (leader in ('A', 'B', 'C', 'D') or leader is null),
  message text not null default '等待主持人开始。',
  updated_at timestamptz not null default now()
);

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  round_id text not null,
  round_index integer not null,
  voter_id text not null,
  choice text not null check (choice in ('A', 'B', 'C', 'D')),
  created_at timestamptz not null default now(),
  unique (round_id, voter_id)
);

alter table public.game_state enable row level security;
alter table public.votes enable row level security;

create policy "public read game_state"
on public.game_state for select
to anon
using (true);

create policy "public write game_state for classroom host"
on public.game_state for all
to anon
using (true)
with check (true);

create policy "public read votes"
on public.votes for select
to anon
using (true);

create policy "vote only while open"
on public.votes for insert
to anon
with check (
  exists (
    select 1 from public.game_state
    where id = 'main'
      and phase = 'voting'
      and voting_open = true
      and voting_locked = false
      and game_state.round_id = votes.round_id
  )
);

create policy "change vote only while open"
on public.votes for update
to anon
using (
  exists (
    select 1 from public.game_state
    where id = 'main'
      and phase = 'voting'
      and voting_open = true
      and voting_locked = false
      and game_state.round_id = votes.round_id
  )
)
with check (
  exists (
    select 1 from public.game_state
    where id = 'main'
      and phase = 'voting'
      and voting_open = true
      and voting_locked = false
      and game_state.round_id = votes.round_id
  )
);

create policy "allow classroom reset"
on public.votes for delete
to anon
using (true);

alter publication supabase_realtime add table public.game_state;
alter publication supabase_realtime add table public.votes;

insert into public.game_state (id)
values ('main')
on conflict (id) do nothing;
```

### 开启 Realtime

`/screen` 页面依赖 Supabase Realtime 接收两类变化：

- `game_state`：当前轮次、阶段、投票是否开放、投票是否锁定、最高票、剧情路线。
- `votes`：学生手机投票和改票。

配置步骤：

1. 在 Supabase 项目左侧进入 `Database`。
2. 打开 `Replication` 或 `Publications`。
3. 找到 `supabase_realtime` publication。
4. 确认 `game_state` 和 `votes` 两张表都已启用 Realtime。
5. 如果界面中没有自动勾选，手动启用这两张表。

上面的 SQL 已包含：

```sql
alter publication supabase_realtime add table public.game_state;
alter publication supabase_realtime add table public.votes;
```

如果重复执行时提示 publication 已经包含该表，说明已开启，可以忽略这个提示。

### 环境变量说明

项目使用三个前端环境变量：

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_HOST_PIN
```

含义：

- `VITE_SUPABASE_URL`：Supabase 项目 URL。
- `VITE_SUPABASE_ANON_KEY`：Supabase 的 `anon public` key。
- `VITE_HOST_PIN`：主持人控制面板 PIN，例如 `2026`。

注意：Vite 只有以 `VITE_` 开头的环境变量会被前端读取。

## 2. Vercel 部署步骤

### 导入 GitHub 仓库

1. 将项目推送到 GitHub。
2. 打开 [Vercel](https://vercel.com/)。
3. 点击 `Add New -> Project`。
4. 选择这个 GitHub 仓库并导入。
5. Framework Preset 选择 `Vite`。

### 构建配置

Vercel 项目配置使用：

```text
Build Command: npm run build
Output Directory: dist
```

项目中已有 `vercel.json`，会把 `/screen`、`/vote` 等前端路由重写到 `index.html`，刷新页面不会 404。

### 配置 Vercel 环境变量

进入 Vercel 项目：

```text
Settings -> Environment Variables
```

添加：

```text
VITE_SUPABASE_URL=你的 Supabase Project URL
VITE_SUPABASE_ANON_KEY=你的 Supabase anon public key
VITE_HOST_PIN=2026
```

添加后重新部署一次。Vite 构建时会把这些变量打进前端包里。

### 测试公网访问

部署成功后，Vercel 会给出一个 HTTPS 地址，例如：

```text
https://your-project.vercel.app
```

依次测试：

```text
https://your-project.vercel.app/screen
https://your-project.vercel.app/vote
```

测试清单：

- `/screen` 能打开大屏页。
- 大屏页显示二维码，二维码指向当前域名的 `/vote`。
- `/vote` 能在手机浏览器打开。
- 大屏控制面板输入 PIN 后可以解锁。
- 点击“开始游戏”后，手机端能看到当前轮问题。
- 点击“开放投票”后，手机端可以投票。
- 手机投票后，大屏票数实时变化。

## 3. 课堂使用步骤

### 大屏端

1. 教室大屏电脑打开：

```text
https://你的 Vercel 域名/screen
```

2. 大屏会展示：

- 游戏标题和当前剧情。
- 当前轮问题。
- A/B/C/D 四个选项。
- 实时票数、百分比和最高票选项。
- 指向 `/vote` 的二维码。
- 同页底部主持人控制面板。

3. 主持人在控制面板输入 PIN，例如：

```text
2026
```

4. 解锁后可以操作：

- `开始游戏`：进入第一幕。
- `开放投票`：允许手机端投票。
- `锁定投票`：关闭本轮投票并固定结果。
- `按最高票推进`：按照多数票进入下一幕剧情。
- `重置游戏`：清空投票并回到初始状态。

### 手机端

1. 学生用手机扫描大屏二维码。
2. 手机进入：

```text
https://你的 Vercel 域名/vote
```

3. 手机端无需登录。
4. 主持人开放投票后，学生直接点击 A/B/C/D。
5. 同一台手机同一轮只计算一票。
6. 投票锁定前，学生再次点击其他选项会改票，不会额外加票。
7. 投票锁定后，手机端按钮会禁用，不能再投。

### 网络要求

- 大屏电脑和学生手机不需要连接同一个 Wi-Fi。
- 手机可以使用校园 Wi-Fi，也可以使用手机流量。
- 只要都能访问同一个 Vercel HTTPS 地址，就可以实时同步。

## 4. 注意事项

- 投票锁定后，手机端不能再投，也不能再改票。
- 如果手机刷新页面，`localStorage` 中保存的 `voterId` 仍在，同一轮不会重复计票。
- 如果大屏刷新页面，当前轮次、票数、路线和锁定状态会从 Supabase 恢复，数据不丢失。
- 如果主持人误操作，可以点击“重置游戏”重新开始。
- 如果二维码扫码失败，可以让学生手动访问 Vercel 地址的 `/vote`。
- 如果大屏显示“Supabase 尚未配置”，检查 Vercel 环境变量是否已添加，并重新部署。
- 如果大屏票数不实时变化，检查 Supabase Realtime 是否已为 `game_state` 和 `votes` 开启。
- 本项目没有复杂账号系统，主持人 PIN 只是课堂防误触，不是严格安全鉴权。
- 不要把 Supabase `service_role` key 放进 `.env.local`、GitHub 或 Vercel。

## 5. 构建检查

部署前可以在本地运行：

```bash
npm install
npm run build
```

构建成功后，Vercel 使用同样的 `npm run build` 即可部署。
