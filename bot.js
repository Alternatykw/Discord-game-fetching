require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Functions for managing data in json file
const fs = require('fs');
const DATA_FILE = process.env.FILE;

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        return {}; 
    }
    
    const rawData = fs.readFileSync(DATA_FILE, 'utf-8');
    if (rawData.trim() === '') {
        return {};
    }
    return JSON.parse(rawData);

}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Function to retrieve last played match IDs for all tracked summoners
async function fetchLastMatches() {
    const data = loadData();
    for (const [guildId, guildData] of Object.entries(data)) {
        const channel = client.channels.cache.find(channel => channel.guild.id === guildId && channel.id === guildData.responseChannel);
        if (!channel) continue;

        for (const [riotId, summonerData] of Object.entries(guildData.trackedSummoners)) {
            const puuid = summonerData.puuid;

            try {
                const matchlistResponse = await axiosWithRetry(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
                    headers: { 'X-Riot-Token': RIOT_API_KEY }
                });

                const latestMatchId = matchlistResponse.data[0];
                if (latestMatchId) {
                    summonerData.lastMatchId = latestMatchId;
                }

            } catch (error) {
                console.error(`Error fetching match history for ${riotId}:`, error.message);
            }

            await new Promise(resolve => setTimeout(resolve, 1500)); 
        }
        saveData(data);
    }
}

// Function to retrieve actual champion names
let championMapping = {};

async function fetchChampionData() {
    try {
        const response = await axios.get(
            "https://ddragon.leagueoflegends.com/cdn/14.23.1/data/en_US/champion.json"
        ); 
        const champions = response.data.data;
        championMapping = Object.fromEntries(
            Object.values(champions).map(champ => [champ.id, champ.name])
        );
    } catch (error) {
        console.error("Error fetching champion data:", error.message);
    }
}

// Preparing the bot
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [
                {
                    name: 'track',
                    description: 'Track a summoner by their Riot ID',
                    options: [
                        {
                            name: 'riotid',
                            type: 3, 
                            description: 'The Riot ID of the summoner (e.g. Summoner#EUNE)',
                            required: true,
                        }
                    ]
                },
                {
                    name: 'untrack',
                    description: 'Stop tracking a summoner by their Riot ID',
                    options: [
                        {
                            name: 'riotid',
                            type: 3, 
                            description: 'The Riot ID of the summoner (e.g. Summoner#EUNE)',
                            required: true,
                        }
                    ]
                },
                {
                    name: 'tracked',
                    description: 'List all currently tracked summoners',
                },
                {
                    name: 'tracker-set',
                    description: 'Set the response channel for tracking updates',
                    options: [
                        {
                            name: 'channel',
                            type: 7,
                            description: 'The name of the channel',
                            required: true,
                        }
                    ]
                }
            ] }
        );
        console.log('Successfully registered application commands.');
    } catch (error) {
        console.error('Error registering application commands:', error);
    }

    await fetchLastMatches();
    console.log('Bot data updated.');
    await fetchChampionData();
    console.log('Champion names fetched.');
    console.log('Bot ready.');

    setInterval(() => {
        checkGameStatus(); 
    }, 60000);
});

// Logic behind discord commands
client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isCommand()) return;

        const data = loadData();
        const guildId = interaction.guildId;

        if (!data[guildId]) {
            data[guildId] = { trackedSummoners: {}, responseChannel: null };
        }

        const guildData = data[guildId];
        const channelName = guildData.responseChannel;

        if (!channelName && interaction.commandName !== 'tracker-set'){
            await interaction.reply(`No response channel set, use "/tracker-set" command.`);
            return;
        }

        if (guildData.responseChannel && interaction.channelId !== guildData.responseChannel && interaction.commandName !== 'tracker-set') {
            const channel = await client.channels.fetch(guildData.responseChannel);
            await interaction.reply({
                content: `Please use ${channel} for the game-tracker commands.`,
                ephemeral: true
            });
            return;
        }

        if (interaction.commandName === 'track') {
            let riotId = interaction.options.getString('riotid').trim();
            riotId = riotId.replace(/\s+/g, ' ').replace(/\s*#\s*/, '#');
            if (!riotId.includes('#')) {
                await interaction.reply("You need a tagline to track a user.");
                return;
            }
            if (guildData.trackedSummoners[riotId]) {
                await interaction.reply(`${riotId} is already being tracked.`);
                return;
            } else {
                const puuid = await getSummonerId(riotId);
                if (!puuid) {
                    await interaction.reply(`User ${riotId} doesn't exist.`);
                    return;
                }
                guildData.trackedSummoners[riotId] = { puuid: puuid, lastMatchId: null };
                try {
                    const matchlistResponse = await axiosWithRetry(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
                        headers: { 'X-Riot-Token': RIOT_API_KEY }
                    });
                    const latestMatchId = matchlistResponse.data[0];
                    guildData.trackedSummoners[riotId].lastMatchId = latestMatchId;
                } catch (error) {
                    console.error(`Error fetching match history for ${riotId}:`, error.message);
                }

                saveData(data);
                await interaction.reply(`Tracking ${riotId} for game status.`);
            }
        }

        if (interaction.commandName === 'untrack') {
            let riotId = interaction.options.getString('riotid').trim();
            riotId = riotId.replace(/\s+/g, ' ').replace(/\s*#\s*/, '#');
            if (!riotId.includes('#')) {
                await interaction.reply("No tagline.");
                return;
            }
            if (guildData.trackedSummoners[riotId]) {
                delete guildData.trackedSummoners[riotId];
                saveData(data);
                await interaction.reply(`Stopped tracking for ${riotId}.`);
            } else {
                await interaction.reply(`${riotId} is currently not being tracked.`);
            }
        }

        if (interaction.commandName === 'tracked') {
            if (Object.keys(guildData.trackedSummoners).length === 0) {
                await interaction.reply("No summoners are currently being tracked.");
            } else {
                const trackedList = Object.keys(guildData.trackedSummoners).sort().join(', ');
                await interaction.reply(`Currently tracking the following summoners: ${trackedList}`);
            }
        }

        if (interaction.commandName === 'tracker-set') {
            const channel = interaction.options.getChannel('channel');
            if (channel && channel.isTextBased()) { 
                guildData.responseChannel = channel.id; 
                saveData(data);
                await interaction.reply(`Response channel set to ${channel}.`);
            } else {
                await interaction.reply("Please select a valid text channel.");
            }
        }

    } catch (error) {
        console.error('Error handling interaction:', error);
        await interaction.reply("There was an error processing your command.");
    }
});

// Helper for 'Service Unavailable' error
async function axiosWithRetry(url, options, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios.get(url, options);
        } catch (error) {
            if (error.response && error.response.status === 503 && i < retries - 1) {
                console.log(`503 error encountered. Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; 
            } else {
                throw error; 
            }
        }
    }
}

// Helper for internet/discord problems
async function isAvailable() {
    try {
        await axios.get('https://discord.com');
        return true;
    } catch (error) {
        return false;
    }
}

// Function to get puuid from riotId
async function getSummonerId(riotId, guildId) {
    const data = loadData();
    if (!data[guildId]) {
        data[guildId] = { trackedSummoners: {} };
    }
    const [gameName, tagLine] = riotId.split('#');

    try {
        const response = await axiosWithRetry(`https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`, {
            headers: { 'X-Riot-Token': RIOT_API_KEY }
        });

        const puuid = response.data.puuid;

        if (!data[guildId].trackedSummoners[riotId]) {
            data[guildId].trackedSummoners[riotId] = { puuid: puuid, lastMatchId: null };
        }

        saveData(data);

        return puuid;
    } catch (error) {
        console.error(`Error fetching summoner ID for ${riotId}:`, error.message);
        return null;
    }
}

// Function to get stats for the tracked summoner
async function getMatchStats(matchId, puuid) {
    try {
        const matchResponse = await axiosWithRetry(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`, {
            headers: { 'X-Riot-Token': RIOT_API_KEY }
        });

        const formatGameTime = (duration) => {
            const minutes = Math.floor(duration / 60);
            const seconds = duration % 60;
            return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
        };

        const gameDuration = matchResponse.data.info.gameDuration;
        if (gameDuration < 300) return null;  
        let gameMode = matchResponse.data.info.gameMode;
        gameMode === "CLASSIC" && (gameMode = "SUMMONERS RIFT");
        const participant = matchResponse.data.info.participants.find(p => p.puuid === puuid);

        const summonerName = participant.summonerName;
        const winStatus = participant.win ? 'Won' : 'Lost';
        const championName = championMapping[participant.championName] || participant.championName;
        const kills = participant.kills;
        const deaths = participant.deaths;
        const assists = participant.assists;
        const kda = deaths > 0 ? ((kills + assists) / deaths).toFixed(2) : 'Perfect KDA';
        const kp = Math.round(participant.challenges.killParticipation * 100) + '%';
        const multikillNumber = participant.largestMultiKill;
        let multikill;
        if (multikillNumber <= 1) {
            multikill = '-';
        } else {
            switch (multikillNumber) {
                case 2:
                    multikill = 'Double Kill';
                    break;
                case 3:
                    multikill = 'Triple Kill';
                    break;
                case 4:
                    multikill = 'Quadra Kill';
                    break;
                default:
                    multikill = 'Penta Kill';
                    break;
            }
        }

        const embed = new EmbedBuilder()
            .setColor(winStatus === 'Won' ? 0x00FF00 : 0xFF0000) 
            .setTitle(`${summonerName} just finished a game!`)
            .addFields(
                { name: 'Result', value: winStatus, inline: true },
                { name: 'Champion', value: championName, inline: true },
                { name: 'KDA', value: `${kills} / ${deaths} / ${assists}`, inline: true },
                { name: 'KDA Ratio', value: kda, inline: true },
                { name: 'KP%', value: kp, inline: true },
                { name: 'Largest Multikill', value: multikill, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: `${gameMode} (${formatGameTime(gameDuration)})` });

        return { embeds: [embed] }; 
    } catch (error) {
        console.error(`Error fetching match stats for match ID ${matchId}:`, error.message);
        return `Could not retrieve match stats for match ID ${matchId}.`;
    }
}

// Function for checking if someone had played a new match
let isChecking = false;

async function checkGameStatus() {
    if (isChecking) return; // Prevent overlapping if there's just too many trackings   
    isChecking = true;

    const connectionCheck = await isAvailable();
    if (!connectionCheck) {
        isChecking = false;
        return;
    }

    const data = loadData();
    const promises = [];

    for (const [guildId, guildData] of Object.entries(data)) {
        const channel = client.channels.cache.find(channel => channel.guild.id === guildId && channel.id === guildData.responseChannel);
        if (!channel) continue;

        for (const [riotId, summonerData] of Object.entries(guildData.trackedSummoners)) {
            const puuid = summonerData.puuid;

            promises.push(
                (async () => {
                    try {
                        const matchlistResponse = await axiosWithRetry(
                            `https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
                            headers: { 'X-Riot-Token': RIOT_API_KEY }
                        });

                        const latestMatchId = matchlistResponse.data[0];
                        if (latestMatchId && latestMatchId !== summonerData.lastMatchId) {
                            const statsMessage = await getMatchStats(latestMatchId, puuid);
                            if (statsMessage) {
                                await channel.send({ embeds: [statsMessage.embeds[0]] });
                            }
                            summonerData.lastMatchId = latestMatchId;
                        }
                    } catch (error) {
                        console.error(`Error fetching match history for ${riotId}:`, error.message);
                    }
                })()
            );

            await new Promise(resolve => setTimeout(resolve, 1500)); 
        }
    }

    await Promise.all(promises);
    saveData(data);
    isChecking = false;
}

client.login(DISCORD_TOKEN);