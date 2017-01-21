const _ = require('underscore');
const request = require('request');
const fs = require("fs");
const Discord = require('discord.js');

// Guild Wars 2
const guildWarsApiKey = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAAAAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"; // Guild leader's API Key, permissions "account" and "guilds"
const guildId = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"; // Guild ID, obtained via API

// Discord
const botToken = "AaAAAaAaAAAaAaAAAaAAAaaAAAaaAaAAaaaaAAAAaaaaAaAAAAAAAAaaAaA";
const serverId = "123456789012345678"; // ID of the discord server
const guildMemberRoleString = "Guild Member"; // Name of role discord users need to have in order to use commands
const botAdminId = "987654321098765432"; // ID of discord user managing the bot
const upgradeReminderTargetIds = ["987654321098765432"]; // IDs of discord users to be notified of ready upgrades, leave empty for no notifications
const dataFileName = "guildData"

const dataPath = __dirname + "/" + dataFileName + ".json";

var bot = new Discord.Client();

var loadedRequests = 0;
// Variables which data is initially loaded into
var guildData; // 1
var finishedUpgradeIds; // 2
var treasuryItems = {}; // 4
var allUpgrades = []; // 8

var crashInfo;
var storedData;
//	{
//	upgradeVotes: {userId: upgradeId}, 
//	queuedUpgrade: {id: upgradeId, votes: voteNumber}, 
//	sentInitialUpgradeReminder: [targetId],
//	settings: {sendReminders: bool, "postMotd": channelId},
//	motd: motdString
//	}

var availableUpgrades = [];
var affordableUpgrades = [];
var affordableUpgradeIds = [];
var affordableUpgradesTableStringArray;
var expensiveUpgrades = [];
var expensiveUpgradeIds = [];
var expensiveUpgradesTableStringArray;
var maxAetherium;
var winningUpgrades = [{id: -1, votes: -1}];

var guildObject;
var guildMemberRoleId;
var upgradeReminderTargets = [];
var botAdmin;

var guildRequest = request.defaults({
	headers: {"Authorization": "Bearer " + guildWarsApiKey},
	baseUrl: "https://api.guildwars2.com/v2/"
})


function tableStringFromUpgradeList(upgradeList) {
	var tableStringArray = []
	var tableString = "```\n";
	tableString += "Id   Name";
	tableString += " ".repeat(56 - "Name".length);
	tableString += "Favor   ";
	tableString += "Aetherium\n"
	tableString += "-".repeat(64) + "\n";
	for (var i = 0; i < upgradeList.length; i++) {
		var favor = 0;
		var aetherium = 0;
		for (var j = 0; j < upgradeList[i]["costs"].length; j++) {
			var costItem = upgradeList[i]["costs"][j];
			if(costItem["item_id"] == 70701) {
				favor = costItem["count"];
			} else if(costItem["type"] == "Currency") {
				aetherium = costItem["count"];
			}

		}
		tableString += (upgradeList[i]["id"]) + " ".repeat(5 - String(upgradeList[i]["id"]).length);
		tableString += upgradeList[i]["name"];
		tableString += " ".repeat(56 - upgradeList[i]["name"].length);
		tableString += favor;
		tableString += " ".repeat(8 - String(favor).length);
		tableString += aetherium;
		tableString += "\n"
		if(tableString.length > 1900) {
			tableStringArray.push(tableString);
			tableString = "";
		}
	}
	tableString += "```";
	tableStringArray.push(tableString);
	return tableStringArray;
}

var writingData = false;
function saveData() {
	if(writingData) {
		setTimeout(saveData, 1000*10)
	} else {
		writingData = true;
		fs.rename( dataPath, __dirname + "/" + dataFileName + "-backup.json", function(err) {
			if(err) {
				console.log(err);
			} else {
				fs.writeFile( dataPath, JSON.stringify( storedData ), "utf8", function(err) {
					if(err) {
						console.log(err);
					} else {
						writingData = false;
					}
				});
			}
		});
	}
}
function upgradeNameForId(upgradeId) {
	var upgrade = upgradeForId(upgradeId);
	if(upgrade == null) {
		return "Nonexistent Upgrade";
	} else {
		return upgrade["name"]
	}
}
function upgradeForId(upgradeId) {
	for (var i = 0; i < allUpgrades.length; i++) {
		if(allUpgrades[i]["id"] == upgradeId) {
			return allUpgrades[i];
		}
	}
	return null;
}
// Count votes and return in format {upgradeId: voteNumber}
function getVoteCount() {
	var voteCount = {};
	for(var userId in storedData.upgradeVotes) {
		upgradeId = storedData.upgradeVotes[userId];
		if( _.contains(affordableUpgradeIds, upgradeId) ) {
			if (upgradeId in voteCount) {
				voteCount[upgradeId] = voteCount[upgradeId] + 1;
			} else {
				voteCount[upgradeId] = 1
			}
		}
	}
	return voteCount;
}
function remindForQueuedUpgrade(reminderTargets) {
	if(storedData.queuedUpgrade["id"] != -1 && upgradeReminderTargetIds.length != 0 && storedData.settings["sendReminders"]) {
		var upgrade;
		for (var i = 0; i < affordableUpgrades.length; i++) {
			if(affordableUpgrades[i]["id"] == storedData.queuedUpgrade["id"]) {
				upgrade = affordableUpgrades[i];
			}
		}
		if(upgrade != null) {
			var favorCost = 0;
			var aetheriumCost = 0;
			for (var j = 0; j < upgrade["costs"].length; j++) {
				var costItem = upgrade["costs"][j];
				if(costItem["item_id"] == 70701) {
					favorCost = costItem["count"];
				} else if(costItem["type"] == "Currency") {
					aetheriumCost = costItem["count"];
				}
			}
			if(guildData["aetherium"] >= aetheriumCost && guildData["favor"] >= favorCost) {
				for (var i = 0; i < reminderTargets.length; i++) {
					reminderTargets[i].sendMessage("The vote-winning \"" + upgrade["name"] + "\" is ready to upgrade");
					storedData.sentInitialUpgradeReminder.push(reminderTargets[i]);
				}
				saveData();
			}
		}
	}
}
// Check which votes have won. Returns true unless no valid votes are found.
function checkVotedUpgrade() {
	var newWinningUpgrades = [{id: -1, votes: -1}];
	var voteCount = getVoteCount();
	// Find upgrade(s) with the highest vote count and put in newWinningUpgrades, which has the format [{id: upgradeId, votes: voteNumber}]
	for(var upgradeId in voteCount) {
		if(voteCount[upgradeId] > newWinningUpgrades[0]["votes"]) {
			newWinningUpgrades = [{ id: upgradeId, votes: voteCount[upgradeId] }];
		} else if(voteCount[upgradeId] == newWinningUpgrades[0]["votes"]) {
			newWinningUpgrades.push({ id: upgradeId, votes: voteCount[upgradeId] })
		}
	}
	winningUpgrades = newWinningUpgrades;


	function queuedUpgradeIsAmongWinners() {
		for (var i = 0; i < winningUpgrades.length; i++) {
			if(winningUpgrades[i]["id"] == storedData.queuedUpgrade["id"]) {
				return true;
			}
		}
		return false;
	}
	if(winningUpgrades.length == 1) {
		if(winningUpgrades[0]["id"] != storedData.queuedUpgrade["id"]) {
			storedData.sentInitialUpgradeReminder = [];
		}
		storedData.queuedUpgrade = winningUpgrades[0];
	} else if(winningUpgrades.length >= 2) {
		if(!queuedUpgradeIsAmongWinners()) {
			storedData.sentInitialUpgradeReminder = [];
			storedData.queuedUpgrade = winningUpgrades[0]
		}
	}

	if( _.difference(upgradeReminderTargets, storedData.sentInitialUpgradeReminder) != [] ) {
		remindForQueuedUpgrade( _.difference(upgradeReminderTargets, storedData.sentInitialUpgradeReminder) );
	}
}

function loadData() {
	guildRequest("guild/" + guildId, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			guildData = JSON.parse(body);
			if(guildData) {
				loadedRequests = loadedRequests | 1;
				useData();
			}
		}
	});
	guildRequest("guild/" + guildId + "/upgrades", function (error, response, body) {
		if (!error && response.statusCode == 200) {
			finishedUpgradeIds = JSON.parse(body);
			if(finishedUpgradeIds) {
				loadedRequests = loadedRequests | 2;

				maxAetherium = 500;
				if(_.contains(finishedUpgradeIds, 546)) {
					maxAetherium = 25000;
				} else if(_.contains(finishedUpgradeIds, 301)) {
					maxAetherium = 15000;
				} else if(_.contains(finishedUpgradeIds, 486)) {
					maxAetherium = 10000;
				} else if(_.contains(finishedUpgradeIds, 120)) {
					maxAetherium = 5000;
				} else if(_.contains(finishedUpgradeIds, 310)) {
					maxAetherium = 3000;
				} else if(_.contains(finishedUpgradeIds, 331)) {
					maxAetherium = 1500;
				}
				useData();
			}
		}
	});
	guildRequest("guild/" + guildId + "/treasury", function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var fullTreasury = JSON.parse(body);
			if(fullTreasury) {
				for (var i = fullTreasury.length - 1; i >= 0; i--) {
					treasuryItems[fullTreasury[i]["item_id"]] = fullTreasury[i]["count"];
				}
				loadedRequests = loadedRequests | 4;
				useData();
			}
		}
	});
	guildRequest("guild/upgrades", function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var allUpgradeIds = JSON.parse(body);
			if(allUpgradeIds) {
				var upgradeIdStrings = [];
				var allUpgradesLoading = [];
				for (var i = 0; i < allUpgradeIds.length; i+=199) {
					var slice;
					if (allUpgradeIds.length - i <= 199) {
						slice = allUpgradeIds.slice(i);
					} else {
						slice = allUpgradeIds.slice(i, i+199)
					}
					upgradeIdStrings.push(slice.join());
				}

				var loadedUpgradeRequestCount = 0;
				for (var i = 0; i < upgradeIdStrings.length; i++) {
					guildRequest("guild/upgrades?ids="+upgradeIdStrings[i], function (error, response, body) {
						if (!error && response.statusCode == 200) {
							upgradeChunk = JSON.parse(body)
							allUpgradesLoading = allUpgradesLoading.concat(upgradeChunk);
							loadedUpgradeRequestCount++;
							if(loadedUpgradeRequestCount == upgradeIdStrings.length) {
								allUpgrades = allUpgradesLoading;
								loadedRequests = loadedRequests | 8;
								useData();
							}
						}
					});
				}
			}
		}
	});
}

var usingData = false;
function useData() {
	if((loadedRequests & 15) == 15 && !usingData) {
		usingData = true;
		var affordableUpgradesLoading = [];
		var expensiveUpgradesLoading = [];
		for (var i = 0; i < allUpgrades.length; i++) {
			var upgrade = allUpgrades[i];
			if( upgrade["required_level"] <= guildData["level"] && !_.contains(finishedUpgradeIds, upgrade["id"]) ) {
				prerequisitesCompleted = true;
				treasuryItemsDeposited = true;
				isAnActualUpgrade = true;
				if(upgrade["type"] == "Claimable" || upgrade["type"] == "Consumable" || upgrade["type"] == "Decoration") {
					isAnActualUpgrade = false;
				}
				if( (upgrade["id"] == 410 || upgrade["id"] == 629 || upgrade["type"] == "GuildHall") && _.contains(finishedUpgradeIds, 407) ) {
					isAnActualUpgrade = false;
				}

				for (var j = 0; j < upgrade["prerequisites"].length; j++) {
					if( !_.contains(finishedUpgradeIds, upgrade["prerequisites"][j]) ) {
						prerequisitesCompleted = false;
					}
				}

				for (var j = 0; j < upgrade["costs"].length; j++) {
					var costItem = upgrade["costs"][j];
					if (costItem["type"] == "Item") {
						if( _.has(treasuryItems, costItem["item_id"]) && treasuryItems[costItem["item_id"]] >= costItem["count"] ) {
							// Yay!
						} else {
							treasuryItemsDeposited = false;
						}
					}
				}

				if(prerequisitesCompleted && treasuryItemsDeposited && isAnActualUpgrade) {
					affordableUpgradesLoading.push(upgrade);
				} else if(prerequisitesCompleted && isAnActualUpgrade) {
					expensiveUpgradesLoading.push(upgrade);
				}
			}
		}
		affordableUpgrades = affordableUpgradesLoading;
		expensiveUpgrades = expensiveUpgradesLoading;
		availableUpgrades = affordableUpgrades.concat(expensiveUpgrades);
		for (var i = 0; i < affordableUpgrades.length; i++) {
			affordableUpgradeIds.push(affordableUpgrades[i]["id"]);
		}
		for (var i = 0; i < expensiveUpgrades.length; i++) {
			expensiveUpgradeIds.push(expensiveUpgrades[i]["id"]);
		}
		affordableUpgradesTableStringArray = tableStringFromUpgradeList(affordableUpgrades);
		expensiveUpgradesTableStringArray = tableStringFromUpgradeList(expensiveUpgrades);
		checkVotedUpgrade();
		if(guildData.motd != storedData.motd) {
			storedData.motd = guildData.motd;
			if(storedData.settings["motdChannel"] != "" && guildObject.channels.has(storedData.settings["motdChannel"]) ) {
				guildObject.channels.get(storedData.settings["motdChannel"]).sendMessage(storedData.motd)
			}
		}
		saveData();
		usingData = false;
	}
}

bot.on("message", function(message) {
	if( message.content.startsWith("!guild") && message.author != bot.user && (message.channel.type != "text" || message.channel.permissionsFor(bot.user).hasPermission("SEND_MESSAGES") ) ) {
		if( guildObject.member(message.author)!=null && guildObject.member(message.author).roles.has(guildMemberRoleId) ) {
			if(message.content == "!guild favor") {
				message.channel.sendMessage("Current Favor: **" + guildData["favor"] + "** of 6000");
			} else if(message.content == "!guild aetherium") {
				message.channel.sendMessage("Current Aetherium: **" + guildData["aetherium"] + "** of " + maxAetherium)
			} else if(message.content == "!guild upgrades") {
				message.channel.sendMessage("```Affordable Upgrades:```");
				for(var stringIndex in affordableUpgradesTableStringArray) {
					message.channel.sendMessage(affordableUpgradesTableStringArray[stringIndex]);
				}
				message.channel.sendMessage("```Not Affordable Upgrades:```");
				for(var stringIndex in expensiveUpgradesTableStringArray) {
					message.channel.sendMessage(expensiveUpgradesTableStringArray[stringIndex]);
				}
			} else if(message.content.startsWith("!guild upgrade ")) {
				var upgradeId = Number( message.content.match(/[0-9]{1,6}$/) );
				var upgrade = upgradeForId(upgradeId);
				if(upgrade == null) {
					message.reply("Well that upgrade just plain doesn't exist.")
				} else {
					if(upgrade["costs"].length > 0) {
						var upgradeMessage = upgrade["name"] + "\n\n```\n";
						for (var j = 0; j < upgrade["costs"].length; j++) {
							var costItem = upgrade["costs"][j];
							if (costItem["type"] == "Item") {
								var treasuryCount = 0;
								if( _.has(treasuryItems, costItem["item_id"]) ) {
									treasuryCount = treasuryItems[costItem["item_id"]];
								}
								upgradeMessage += costItem["count"] + " " + costItem["name"] + " (" + treasuryCount + " in treasury)\n";
							}
						}
						upgradeMessage += "```"
						message.channel.sendMessage(upgradeMessage);
					}
				}
			} else if(message.content.startsWith("!guild vote ")) {
				var votedUpgradeId = Number( message.content.match(/[0-9]{1,6}$/) );
				storedData.upgradeVotes[message.author.id] = votedUpgradeId
				saveData();
				message.reply("Your have voted for \"" + upgradeNameForId(storedData.upgradeVotes[message.author.id]) + "\"")
			} else if(message.content == "!guild myvote") {
				message.reply("Your vote is for \"" + upgradeNameForId(storedData.upgradeVotes[message.author.id]) + "\"" )
				if( _.contains(finishedUpgradeIds, storedData.upgradeVotes[message.author.id]) ) {
					message.reply("Your vote is for an already finished Upgrade");
				}
			} else if(message.content == "!guild votes") {
				var voteCount = getVoteCount();
				var votesMessage = "```\n";
				for(upgradeId in voteCount) {
					votesMessage += voteCount[upgradeId] + " votes for " + upgradeNameForId(upgradeId) + "\n";
				}
				votesMessage += "```"
				message.channel.sendMessage(votesMessage);
			} else if(message.content == "!guild help") {
				var helpMessage = "```\n"
				helpMessage += "!guild favor              for the current favor amount.\n\n";
				helpMessage += "!guild aetherium          for the current aetherium amount.\n\n";
				helpMessage += "!guild upgrades           for all available upgrades affordable\n";
				helpMessage += "                          with the items in the treasury.\n\n";
				helpMessage += "!guild upgrade upgradeId  for a list of items needed for the upgrade.\n\n";
				helpMessage += "!guild vote upgradeId     to vote for the upgrade with the given id.\n";
				helpMessage += "                          Refer to !guild upgrades for ids.\n\n";
				helpMessage += "!guild myvote             to check which upgrade you've voted for.\n\n";
				helpMessage += "!guild votes              to see the current voting results.\n";
				helpMessage += "                          Only affordable upgrades are shown.\n\n";
				helpMessage += "!guild motd               for the current Message of the Day.\n\n";
				helpMessage += "!guild motdChannel        to automatically post MotDs in the current channel.\n";
				helpMessage += "                          They will stop being posted in any previous channel.\n";
				helpMessage += "                          If they are being posted in the current channel\n";
				helpMessage += "                          they will be disabled.\n";
				helpMessage += "```"
				message.author.sendMessage(helpMessage)
			} else if(message.content == "!guild motd") {
				message.channel.sendMessage(guildData["motd"])
			} else if(message.content == "!guild motdChannel" && message.channel.type == "text") {
				if(storedData.settings["motdChannel"] != message.channel.id) {
					storedData.settings["motdChannel"] = message.channel.id
					message.channel.sendMessage("Messages of the day will be posted to #" + message.channel.name)
				} else {
					storedData.settings["motdChannel"] = ""
					message.channel.sendMessage("Messages of the day have been disabled")
				}
				saveData();	
			}
		} else {
			message.reply("You're not in the guild");
		}
	}
});

bot.on("presence", function(oldUser, newUser) {
	if(newUser.game != null && newUser.game.name == "Guild Wars 2" && _.contains(upgradeReminderTargets, newUser.id) ) {
		remindForQueuedUpgrade([newUser.id]);
	}
});

bot.on('ready', () => {
	startup();
});

bot.on('disconnected', () => {
	bot.login(botToken);
});


function saveCrashInfo(callback) {
	fs.writeFile( __dirname + "/" + dataFileName + "-crashInfo.json", JSON.stringify( crashInfo ), "utf8", callback );
}

function startup() {
	if(bot.guilds.get(serverId)!=null) {
		crashInfo = require(__dirname + "/" + dataFileName + "-crashInfo.json");
		guildObject = bot.guilds.get(serverId);
		guildMemberRoleId = guildObject.roles.find("name", guildMemberRoleString).id;
		for(var targetIndex in upgradeReminderTargetIds) {
			upgradeReminderTargets.push( bot.resolver.resolveUser(upgradeReminderTargetIds[targetIndex]) );
		}
		botAdmin = bot.resolver.resolveUser(botAdminId);
		var date = new Date();
		if( date.now - crashInfo["lastReady"] < 10000 ) {
			crashInfo["fastCrashes"] = crashInfo["fastCrashes"] + 1;
		}
		if( crashInfo["fastCrashes"] >= 5 ) {
			botAdmin.sendMessage( "Problem Time! – " + date.toLocaleTimeString() );
			bot.user.setPresence({"status": "dnd", "afk": true, "game": {"name": "x_x"}});
			saveCrashInfo( function(err) {
				if(err) {
					console.log(err);
				}
			});
		} else {
			crashInfo["lastReady"] = date.now;
			saveCrashInfo( function(err) {
				if(err) {
					console.log(err);
				} else {
					storedData = require(dataPath);
					loadData();
					bot.user.setPresence({"status": "online", "afk": false, "game": {"name": "!guild help"}});
					setInterval(loadData, 1000*60*2);
				}
			});
		}
	} else {
		setTimeout(startup, 1000*30)
	}
}

bot.on('error', e => { console.error(e); });

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
	// application specific logging, throwing an error, or other logic here
});


bot.login(botToken);
