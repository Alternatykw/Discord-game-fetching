require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const RIOT_API_KEY = process.env.RIOT_API_KEY;

const trackedSummoners = new Set();
const inGameSummoners = new Map();

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    setInterval(checkGameStatus, 60000);
});

client.on('messageCreate', message => {
    if (message.content.startsWith('!track')) {
        const riotId = message.content.substring(6).trim(); 
        if (riotId.includes('#')){
            trackedSummoners.add(riotId);
            message.channel.send(`Tracking ${riotId} for game status.`);
        } else {
            message.channel.send("You need a tagline to track a user.");
        }
    }
});

async function getSummonerId(riotId) {
    const channel = client.channels.cache.find(channel => channel.name === process.env.CHANNEL_NAME);
    const [gameName, tagLine] = riotId.split('#');
    try {
        const response = await axios.get(`https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`, {
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

async function getMatchStats(puuid) {
    try {
        const matchlistResponse = await axios.get(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
            headers: { 'X-Riot-Token': RIOT_API_KEY }
        });

        if (matchlistResponse.data.matches.length === 0) {
            return `No recent matches found for PUUID: ${puuid}`;
        }

        const recentMatchId = matchlistResponse.data.matches[0].gameId;

        const matchResponse = await axios.get(`https://europe.api.riotgames.com/lol/match/v5/matches/${recentMatchId}`, {
            headers: { 'X-Riot-Token': RIOT_API_KEY }
        });

        const participantId = matchResponse.data.participantIdentities.find(participant => participant.player.puuid === puuid).participantId;
        const participantStats = matchResponse.data.participants.find(participant => participant.participantId === participantId).stats;

        const kills = participantStats.kills;
        const deaths = participantStats.deaths;
        const assists = participantStats.assists;

        return `${puuid} KDA Stats: ${kills} / ${deaths} / ${assists}`;
    } catch (error) {
        console.error(`Error fetching match stats for ${puuid}:`, error.message);
        return `Could not retrieve match stats for ${puuid}.`;
    }
}

async function checkGameStatus() {
    for (const riotId of trackedSummoners) {
        const puuid = await getSummonerId(riotId);
        if (!puuid) continue; 
        
        try {
            const currentGameResponse = await axios.get(`https://eun1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}`, {
                headers: { 'X-Riot-Token': RIOT_API_KEY }
            });

            const channel = client.channels.cache.find(channel => channel.name === process.env.CHANNEL_NAME);

            if (currentGameResponse.data) {
                const currentGameId = currentGameResponse.data.gameId;

                if (!inGameSummoners.has(riotId)) {
                    inGameSummoners.set(riotId, currentGameId); 
                } else if (inGameSummoners.get(riotId) !== currentGameId) {
                    const statsMessage = await getMatchStats(puuid);
                    channel.send(`${riotId} has finished their game!\n${statsMessage}`);
                    
                    inGameSummoners.set(riotId, currentGameId); 
                }
            } else if (inGameSummoners.has(riotId)) {
                const statsMessage = await getMatchStats(puuid);
                channel.send(`${riotId} has finished their game!\n${statsMessage}`);
                
                inGameSummoners.delete(riotId); 
            }
        } catch (error) {
            if (error.response && error.response.status === 404) {
            } else {
                console.log("Error: " + error);
            }
        }
    }
}

client.login(process.env.DISCORD_TOKEN);
