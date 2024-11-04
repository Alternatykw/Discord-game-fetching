require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const trackedSummoners = new Set();
const lastMatchIds = new Map();

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: [
                {
                    name: 'track',
                    description: 'Track a summoner by their Riot ID',
                    options: [
                        {
                            name: 'riotid',
                            type: 3, 
                            description: 'The Riot ID of the summoner (e.g., Summoner#EUNE)',
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
                            description: 'The Riot ID of the summoner (e.g., Summoner#EUNE)',
                            required: true,
                        }
                    ]
                },
                {
                    name: 'tracked',
                    description: 'List all currently tracked summoners',
                }
            ] }
        );
        console.log('Successfully registered application commands.');
    } catch (error) {
        console.error('Error registering application commands:', error);
    }

    setInterval(() => {
        checkGameStatus(); 
    }, 60000);
});

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isCommand()) return;

        if (interaction.commandName === 'track') {
            const riotId = interaction.options.getString('riotid').trim();
            if (riotId.includes('#')) {
                trackedSummoners.add(riotId);
                const puuid = await getSummonerId(riotId);
                if (!puuid) {
                    await interaction.reply(`User ${riotId} doesn't exist.`);
                    return;
                };

                try {
                    const matchlistResponse = await axiosWithRetry(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
                        headers: { 'X-Riot-Token': RIOT_API_KEY }
                    });

                    const latestMatchId = matchlistResponse.data[0];
                    lastMatchIds.set(riotId, latestMatchId);
                } catch (error) {
                    console.error(`Error fetching match history for ${riotId}:`, error.message);
                }

                await interaction.reply(`Tracking ${riotId} for game status.`);
            } else {
                await interaction.reply("You need a tagline to track a user.");
            }
        }
        if (interaction.commandName === 'untrack') {
            const riotId = interaction.options.getString('riotid').trim();
            if (riotId.includes('#')) {
                if(trackedSummoners.has(riotId)){
                    trackedSummoners.delete(riotId);
                    lastMatchIds.delete(riotId);
                    await interaction.reply(`Stopped tracking for ${riotId}.`);
                }
            } else {
                await interaction.reply("No tagline.");
            }
        }
        if (interaction.commandName === 'tracked') {
            if (trackedSummoners.size === 0) {
                await interaction.reply("No summoners are currently being tracked.");
            } else {
                const trackedList = Array.from(trackedSummoners).join(', ');
                await interaction.reply(`Currently tracking the following summoners: ${trackedList}`);
            }
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        await interaction.reply("There was an error processing your command.");
    }
});

async function axiosWithRetry(url, options, retries = 5, delay = 2000) {
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

async function getSummonerId(riotId) {
    const channel = client.channels.cache.find(channel => channel.name === process.env.CHANNEL_NAME);
    const [gameName, tagLine] = riotId.split('#');
    try {
        const response = await axiosWithRetry(`https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`, {
            headers: { 'X-Riot-Token': RIOT_API_KEY }
        });
        return response.data.puuid; 
    } catch (error) {
        console.error(`Error fetching summoner ID for ${riotId}:`, error.message);
        channel.send(`Summoner ${riotId} doesn't exist.`);
        trackedSummoners.delete(riotId);
        return null;
    }
}

async function getMatchStats(matchId, puuid) {
    try {
        const matchResponse = await axiosWithRetry(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`, {
            headers: { 'X-Riot-Token': RIOT_API_KEY }
        });

        const participant = matchResponse.data.info.participants.find(p => p.puuid === puuid);

        const summonerName = participant.summonerName;
        const winStatus = participant.win ? 'Won' : 'Lost';
        const championName = participant.championName;
        const kills = participant.kills;
        const deaths = participant.deaths;
        const assists = participant.assists;
        const kda = deaths > 0 ? ((kills + assists) / deaths).toFixed(2) : 'Perfect KDA';

        const embed = new EmbedBuilder()
            .setColor(winStatus === 'Won' ? 0x00FF00 : 0xFF0000) 
            .setTitle(`${summonerName} just finished a game!`)
            .addFields(
                { name: 'Result', value: winStatus, inline: true },
                { name: 'Champion', value: championName, inline: true },
                { name: 'KDA', value: `${kills} / ${deaths} / ${assists}`, inline: true },
                { name: 'KDA Ratio', value: kda, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Match Stats' });

        return { embeds: [embed] }; 
    } catch (error) {
        console.error(`Error fetching match stats for match ID ${matchId}:`, error.message);
        return `Could not retrieve match stats for match ID ${matchId}.`;
    }
}

async function checkGameStatus() {
    for (const riotId of trackedSummoners) {
        const puuid = await getSummonerId(riotId);
        if (!puuid) {
            console.log(`No puuid for user ${riotId}`);
            continue;
        };

        try {
            const matchlistResponse = await axiosWithRetry(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
                headers: { 'X-Riot-Token': RIOT_API_KEY }
            });

            const latestMatchId = matchlistResponse.data[0];

            if (latestMatchId && latestMatchId !== lastMatchIds.get(riotId)) {
                const statsMessage = await getMatchStats(latestMatchId, puuid); 
                const channel = client.channels.cache.find(channel => channel.name === process.env.CHANNEL_NAME);
                channel.send({ embeds: [statsMessage.embeds[0]] });

                lastMatchIds.set(riotId, latestMatchId);
            }

        } catch (error) {
            console.error(`Error fetching match history for ${riotId}:`, error.message);
        }
    }
}

client.login(DISCORD_TOKEN);
