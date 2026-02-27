const fs = require("fs");

const path = require("path");

const Gamedig = require("gamedig");

const {

  Client,

  GatewayIntentBits,

  Partials,

  EmbedBuilder,

  SlashCommandBuilder,

  Routes,

} = require("discord.js");

const { REST } = require("@discordjs/rest");

// ==== Load .env manually (لأنه ممكن الهوست ما يدعمش dotenv) ====

function loadEnv() {

  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");

  for (const line of raw.split(/\r?\n/)) {

    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);

    if (!m) continue;

    const key = m[1];

    let val = m[2] ?? "";

    val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

    if (!process.env[key]) process.env[key] = val;

  }

}

loadEnv();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const SERVER_IP = process.env.SERVER_IP || "51.83.173.177";

const SERVER_PORT = Number(process.env.SERVER_PORT || 22003);

const JOIN_CHANNEL_ID = process.env.JOIN_CHANNEL_ID;

const LEAVE_CHANNEL_ID = process.env.LEAVE_CHANNEL_ID;

const POLL_MS = Number(process.env.POLL_MS || 10000);

if (!DISCORD_TOKEN) {

  console.error("Missing DISCORD_TOKEN in .env");

  process.exit(1);

}

if (!JOIN_CHANNEL_ID || !LEAVE_CHANNEL_ID) {

  console.error("Missing JOIN_CHANNEL_ID / LEAVE_CHANNEL_ID in .env");

  process.exit(1);

}

const DATA_FILE = path.join(__dirname, "activity.json");

function startOfISOWeekUTC(date = new Date()) {

  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  const day = d.getUTCDay() || 7; // 1..7

  d.setUTCDate(d.getUTCDate() - (day - 1));

  d.setUTCHours(0, 0, 0, 0);

  return d;

}

function formatHMS(totalSeconds) {

  const s = Math.max(0, Math.floor(totalSeconds));

  const h = Math.floor(s / 3600);

  const m = Math.floor((s % 3600) / 60);

  const r = s % 60;

  return `${h}h ${m}m ${r}s`;

}

function loadData() {

  if (!fs.existsSync(DATA_FILE)) {

    return { weekStartUTC: startOfISOWeekUTC().toISOString(), players: {} };

  }

  try {

    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (!d.weekStartUTC || !d.players) throw new Error("bad schema");

    return d;

  } catch {

    return { weekStartUTC: startOfISOWeekUTC().toISOString(), players: {} };

  }

}

function saveData(d) {

  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), "utf8");

}

let data = loadData();

function maybeResetWeek() {

  const currentWeek = startOfISOWeekUTC();

  const savedWeek = new Date(data.weekStartUTC);

  if (savedWeek.getTime() !== currentWeek.getTime()) {

    data = { weekStartUTC: currentWeek.toISOString(), players: {} };

    saveData(data);

  }

}

function ensurePlayer(name) {

  if (!data.players[name]) data.players[name] = { weeklySeconds: 0, sessions: 0 };

  return data.players[name];

}

// فلترة Gonz

function isGonz(name) {

  if (!name) return false;

  const n = name.toLowerCase();

  return n.includes("gonzalez") || n.includes("gonz");

}

// Discord

const client = new Client({

  intents: [GatewayIntentBits.Guilds],

  partials: [Partials.Channel],

});

async function sendLog(channelId, embed) {

  try {

    const ch = await client.channels.fetch(channelId);

    if (!ch) return;

    await ch.send({ embeds: [embed] });

  } catch (e) {

    console.error("Send log error:", e?.message || e);

  }

}

// تتبع الحالي

let lastSeen = new Set();

const onlineNow = new Map(); // name -> joinMs

async function pollServer() {

  try {

    maybeResetWeek();

    const state = await Gamedig.query({

      type: "mtasa",

      host: SERVER_IP,

      port: SERVER_PORT,

      socketTimeout: 3000,

      maxAttempts: 2,

    });

    const allNames = (state.players || []).map(p => p?.name).filter(Boolean);

    const filtered = allNames.filter(isGonz);

    const current = new Set(filtered);

    // joins

    for (const name of current) {

      if (!lastSeen.has(name)) {

        onlineNow.set(name, Date.now());

        const p = ensurePlayer(name);

        p.sessions += 1;

        const embed = new EmbedBuilder()

          .setTitle("✅ دخول لاعب (Gonz)")

          .setDescription(`**اللاعب:** ${name}\n**التفاعل الأسبوعي:** ${formatHMS(p.weeklySeconds)}`)

          .setFooter({ text: `Server: ${SERVER_IP}:${SERVER_PORT} | Week(UTC): ${data.weekStartUTC}` })

          .setTimestamp(new Date());

        await sendLog(JOIN_CHANNEL_ID, embed);

      }

    }

    // quits

    for (const name of lastSeen) {

      if (!current.has(name)) {

        const joinedAt = onlineNow.get(name);

        const now = Date.now();

        const sessionSeconds = joinedAt ? Math.max(0, Math.floor((now - joinedAt) / 1000)) : 0;

        onlineNow.delete(name);

        const p = ensurePlayer(name);

        p.weeklySeconds += sessionSeconds;

        saveData(data);

        const embed = new EmbedBuilder()

          .setTitle("❌ خروج لاعب (Gonz)")

          .setDescription(

            `**اللاعب:** ${name}\n` +

            `**مدة الجلسة:** ${formatHMS(sessionSeconds)}\n` +

            `**التفاعل الأسبوعي:** ${formatHMS(p.weeklySeconds)}`

          )

          .setFooter({ text: `Server: ${SERVER_IP}:${SERVER_PORT} | Week(UTC): ${data.weekStartUTC}` })

          .setTimestamp(new Date());

        await sendLog(LEAVE_CHANNEL_ID, embed);

      }

    }

    lastSeen = current;

    saveData(data);

  } catch (err) {

    console.error("Poll error:", err?.message || err);

  }

}

// Slash command

async function registerCommands() {

  const cmd = new SlashCommandBuilder()

    .setName("gonz-week")

    .setDescription("يعرض تفاعل لاعبين Gonz هذا الأسبوع.")

    .addIntegerOption(o =>

      o.setName("top").setDescription("عدد النتائج (افتراضي 15)").setRequired(false).setMinValue(1).setMaxValue(50)

    );

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(Routes.applicationCommands(client.user.id), { body: [cmd.toJSON()] });

}

client.once("ready", async () => {

  console.log(`Logged in as ${client.user.tag}`);

  try {

    await registerCommands();

    console.log("Slash commands registered.");

  } catch (e) {

    console.error("Command register error:", e?.message || e);

  }

  setInterval(pollServer, POLL_MS);

  pollServer();

});

client.on("interactionCreate", async (interaction) => {

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "gonz-week") {

    maybeResetWeek();

    const top = interaction.options.getInteger("top") ?? 15;

    const entries = Object.entries(data.players)

      .map(([name, v]) => ({ name, weeklySeconds: v.weeklySeconds || 0, sessions: v.sessions || 0 }))

      .filter(x => isGonz(x.name))

      .sort((a, b) => b.weeklySeconds - a.weeklySeconds)

      .slice(0, top);

    if (entries.length === 0) {

      return interaction.reply({ content: "مفيش بيانات تفاعل الأسبوع ده لحد دلوقتي.", ephemeral: true });

    }

    const lines = entries.map((e, i) => `**${i + 1}.** ${e.name} — ${formatHMS(e.weeklySeconds)} (Sessions: ${e.sessions})`);

    const embed = new EmbedBuilder()

      .setTitle("📊 تفاعل لاعبين Gonz (أسبوعيًا)")

      .setDescription(lines.join("\n"))

      .setFooter({ text: `Week starts (UTC): ${data.weekStartUTC}` })

      .setTimestamp(new Date());

    return interaction.reply({ embeds: [embed] });

  }

});

client.login(DISCORD_TOKEN);
