import { WWOEvents, WWOPlayerRoom, WWOPlayerScene, } from "./api/WWOAPI";
import path from "path";
import { InjectCore } from "modloader64_api/CoreInjection";
import { DiscordStatus } from "modloader64_api/Discord";
import { EventHandler, PrivateEventHandler, EventsClient, bus } from "modloader64_api/EventHandler";
import { IModLoaderAPI, IPlugin, ModLoaderEvents } from "modloader64_api/IModLoaderAPI";
import { ModLoaderAPIInject } from "modloader64_api/ModLoaderAPIInjector";
import { INetworkPlayer, LobbyData, NetworkHandler } from "modloader64_api/NetworkHandler";
import { Preinit, Init, Postinit, onTick } from "modloader64_api/PluginLifecycle";
import { ParentReference, SidedProxy, ProxySide } from "modloader64_api/SidedProxy/SidedProxy";
import { WWO_UpdateSaveDataPacket, WWO_DownloadRequestPacket, WWO_ScenePacket, WWO_SceneRequestPacket, WWO_DownloadResponsePacket, WWO_BottleUpdatePacket, WWO_ErrorPacket, WWO_RoomPacket, WWO_RupeePacket, WWO_FlagUpdate, WWO_LiveFlagUpdate, WWO_RegionFlagUpdate, WWO_ClientSceneContextUpdate } from "./network/WWOPackets";
import { IWWOnlineLobbyConfig, WWOnlineConfigCategory } from "./WWOHideAndSeek";
import { WWOSaveData } from "./save/WWOnlineSaveData";
import { WWOnlineStorage } from "./storage/WWOnlineStorage";
import { WWOnlineStorageClient } from "./storage/WWOnlineStorageClient";
import fs from 'fs';
import { WWO_PRIVATE_EVENTS } from "./api/InternalAPI";
import WWSerialize from "./storage/WWSerialize";
import { InventoryItem, IWWCore, WWEvents } from "WindWaker/API/WWAPI";
import { parseFlagChanges } from "./save/parseFlagChanges";
import * as API from "WindWaker/API/WWAPI";
import { PuppetOverlord } from "./puppet/PuppetOverlord";
import bitwise from 'bitwise';
import { StageInfo } from "WindWaker/src/StageInfo";

export default class WWOnlineClient {
    @InjectCore()
    core!: IWWCore;

    @ModLoaderAPIInject()
    ModLoader!: IModLoaderAPI;

    @ParentReference()
    parent!: IPlugin;

    //@SidedProxy(ProxySide.CLIENT, PuppetOverlord)
    //puppets!: PuppetOverlord;

    LobbyConfig: IWWOnlineLobbyConfig = {} as IWWOnlineLobbyConfig;
    clientStorage: WWOnlineStorageClient = new WWOnlineStorageClient();
    config!: WWOnlineConfigCategory;

    syncContext: number = -1;
    syncTimer: number = 0;
    synctimerMax: number = 60 * 5;
    syncPending: boolean = false;

    lastRupees: number = 0;
    sentRupees: boolean = false;

    @EventHandler(EventsClient.ON_PLAYER_JOIN)
    onPlayerJoined(player: INetworkPlayer) {
        this.clientStorage.players[player.uuid] = "-1";
        this.clientStorage.networkPlayerInstances[player.uuid] = player;
    }

    @EventHandler(EventsClient.ON_PLAYER_LEAVE)
    onPlayerLeave(player: INetworkPlayer) {
        delete this.clientStorage.players[player.uuid];
        delete this.clientStorage.networkPlayerInstances[player.uuid];
    }

    @Preinit()
    preinit() {
        this.config = this.ModLoader.config.registerConfigCategory("WWOnline") as WWOnlineConfigCategory;
        //if (this.puppets !== undefined) {
        //    this.puppets.clientStorage = this.clientStorage;
        //}
    }

    @Init()
    init(): void {
    }

    @Postinit()
    postinit() {
        //this.clientStorage.scene_keys = JSON.parse(fs.readFileSync(__dirname + '/localization/scene_names.json').toString());
        this.clientStorage.localization = JSON.parse(fs.readFileSync(__dirname + '/localization/scene_names.json').toString());
        this.clientStorage.localization_island = JSON.parse(fs.readFileSync(__dirname + '/localization/island_names.json').toString());
        let status: DiscordStatus = new DiscordStatus('Playing WWOnline', 'On the title screen');
        status.smallImageKey = 'WWO';
        status.partyId = this.ModLoader.clientLobby;
        status.partyMax = 30;
        status.partySize = 1;
        this.ModLoader.gui.setDiscordStatus(status);
        this.clientStorage.saveManager = new WWOSaveData(this.core, this.ModLoader);
        this.ModLoader.utils.setIntervalFrames(() => {
            this.inventoryUpdateTick();
        }, 20);
    }

    updateInventory() {
        if (this.core.helper.isTitleScreen() || !this.core.helper.isSceneNameValid() || this.core.helper.isPaused() || !this.clientStorage.first_time_sync) return;
        if (this.syncTimer > this.synctimerMax) {
            this.clientStorage.lastPushHash = this.ModLoader.utils.hashBuffer(Buffer.from("RESET"));
            //this.ModLoader.logger.debug("Forcing resync due to timeout.");
            //this.core.save.swords.swordLevel = API.Sword.Master;
            //this.core.save.shields.shieldLevel = API.Shield.MIRROR;
            //console.log(`save: ${this.core.save.swords.swordLevel}, ${this.core.save.shields.shieldLevel}`);
        }
        let save = this.clientStorage.saveManager.createSave();
        if (this.clientStorage.lastPushHash !== this.clientStorage.saveManager.hash) {
            this.ModLoader.privateBus.emit(WWO_PRIVATE_EVENTS.DOING_SYNC_CHECK, {});
            //this.ModLoader.privateBus.emit(WWO_PRIVATE_EVENTS.LOCK_ITEM_NOTIFICATIONS, {});
            this.ModLoader.clientSide.sendPacket(new WWO_UpdateSaveDataPacket(this.ModLoader.clientLobby, save, this.clientStorage.world));
            this.clientStorage.lastPushHash = this.clientStorage.saveManager.hash;
            this.syncTimer = 0;
        }
    }

    /* updateRupees() {
        let rupees = this.core.save.inventory.rupeeCount;
        if (rupees !== this.lastRupees && !this.sentRupees) {
            this.ModLoader.logger.info(`Rupees changed with delta ` + (rupees - this.lastRupees).toString());
            this.ModLoader.clientSide.sendPacket(new WWO_RupeePacket(rupees - this.lastRupees, this.ModLoader.clientLobby))
            this.sentRupees = true;
        }
        this.lastRupees = rupees;
    } */

    updateFlags() {
        if (this.core.helper.isTitleScreen() || !this.core.helper.isSceneNameValid() || this.core.helper.isPaused() || !this.clientStorage.first_time_sync) return;
        if (!this.clientStorage.eventFlags.equals(this.core.save.eventFlags)) {
            for (let i = 0; i < this.clientStorage.eventFlags.byteLength; i++) {
                let byteStorage = this.clientStorage.eventFlags.readUInt8(i);
                let byteIncoming = this.core.save.eventFlags.readUInt8(i);
                if (byteStorage !== byteIncoming && byteIncoming !== 0x0) {
                    console.log(`Client: Parsing flag: 0x${i.toString(16)}, byteStorage: 0x${byteStorage.toString(16)}, byteIncoming: 0x${byteIncoming.toString(16)}`);
                }
            }
            this.clientStorage.eventFlags = this.core.save.eventFlags;
            this.ModLoader.clientSide.sendPacket(new WWO_FlagUpdate(this.clientStorage.eventFlags, this.ModLoader.clientLobby));
        }
    }

    autosaveSceneData() {
        if (!this.core.helper.isLoadingZone() && this.core.global.current_scene_frame > 20 && this.clientStorage.first_time_sync) {

            let live_scene_chests: Buffer = this.core.save.stage_Live.chests;
            let live_scene_switches: Buffer = this.core.save.stage_Live.switches;
            let live_scene_collect: Buffer = this.core.save.stage_Live.items;
            let live_scene_rooms: Buffer = this.core.save.stage_Live.rooms;
            let save_scene_data: Buffer = this.core.global.getSaveDataForCurrentScene();
            let save: Buffer = Buffer.alloc(0x24);

            live_scene_chests.copy(save, 0x0); // Chests
            live_scene_switches.copy(save, 0x4); // Switches
            live_scene_collect.copy(save, 0x14); // Collectables
            live_scene_rooms.copy(save, 0x18); //  Visited Rooms
            save[0x20] = this.core.save.stage_Live.keys; // Key Count

            let save_hash_2: string = this.ModLoader.utils.hashBuffer(save);
            if (save_hash_2 !== this.clientStorage.autoSaveHash) {
                this.ModLoader.logger.info('autosaveSceneData()');
                save_scene_data.copy(save, 0x21, 0x21, 0x23);
                for (let i = 0; i < save_scene_data.byteLength; i++) {
                    save_scene_data[i] |= save[i];
                }
                this.clientStorage.autoSaveHash = save_hash_2;
            }
            else {
                return;
            }
            this.core.global.writeSaveDataForCurrentScene(save_scene_data);
            this.ModLoader.clientSide.sendPacket(new WWO_ClientSceneContextUpdate(this.core.save.stage_Live, this.ModLoader.clientLobby, this.core.global.current_stage_id, this.clientStorage.world));
        }
    }

    updateBottles(onlyfillCache = false) {
        let bottles: InventoryItem[] = [
            this.core.save.inventory.FIELD_BOTTLE1,
            this.core.save.inventory.FIELD_BOTTLE2,
            this.core.save.inventory.FIELD_BOTTLE3,
            this.core.save.inventory.FIELD_BOTTLE4,
        ];
        for (let i = 0; i < bottles.length; i++) {
            if (bottles[i] !== this.clientStorage.bottleCache[i]) {
                this.clientStorage.bottleCache[i] = bottles[i];
                this.ModLoader.logger.info('Bottle update.');
                if (!onlyfillCache) {
                    this.ModLoader.clientSide.sendPacket(new WWO_BottleUpdatePacket(i, bottles[i], this.ModLoader.clientLobby));
                }
            }
        }
    }

    //------------------------------
    // Lobby Setup
    //------------------------------

    @EventHandler(EventsClient.ON_SERVER_CONNECTION)
    onConnect() {
        this.ModLoader.logger.debug("Connected to server.");
        this.clientStorage.first_time_sync = false;
    }

    @EventHandler(EventsClient.CONFIGURE_LOBBY)
    onLobbySetup(lobby: LobbyData): void {
        lobby.data['WWOnline:data_syncing'] = true;
    }

    @EventHandler(EventsClient.ON_LOBBY_JOIN)
    onJoinedLobby(lobby: LobbyData): void {
        this.clientStorage.first_time_sync = false;
        this.LobbyConfig.data_syncing = lobby.data['WWOnline:data_syncing'];
        this.ModLoader.logger.info('WWOnline settings inherited from lobby.');
    }

    //------------------------------
    // Scene handling
    //------------------------------

    @EventHandler(WWEvents.ON_SAVE_LOADED)
    onSaveLoad(Scene: number) {
        if (!this.clientStorage.first_time_sync && !this.syncPending) {

            this.ModLoader.utils.setTimeoutFrames(() => {
                if (this.LobbyConfig.data_syncing) {
                    this.ModLoader.me.data["world"] = this.clientStorage.world;
                    this.ModLoader.clientSide.sendPacket(new WWO_DownloadRequestPacket(this.ModLoader.clientLobby, new WWOSaveData(this.core, this.ModLoader).createSave()));
                }
            }, 50);
            this.syncPending = true;
        }
    }

    @EventHandler(WWEvents.ON_SCENE_CHANGE)
    onSceneChange(scene: string) {
        if (!this.clientStorage.first_time_sync && !this.syncPending) {
            this.ModLoader.utils.setTimeoutFrames(() => {
                if (this.LobbyConfig.data_syncing) {
                    this.ModLoader.me.data["world"] = this.clientStorage.world;
                    this.ModLoader.clientSide.sendPacket(new WWO_DownloadRequestPacket(this.ModLoader.clientLobby, new WWOSaveData(this.core, this.ModLoader).createSave()));
                    //this.ModLoader.clientSide.sendPacket(new WWO_RomFlagsPacket(this.ModLoader.clientLobby, RomFlags.isWWR, RomFlags.isVanilla));
                }
            }, 300);
            this.syncPending = true;
        }
        this.ModLoader.clientSide.sendPacket(
            new WWO_ScenePacket(
                this.ModLoader.clientLobby,
                scene
            )
        );
        this.ModLoader.logger.info('client: I moved to scene ' + (this.clientStorage.localization[scene] || scene) + '.');
        if (this.core.helper.isSceneNameValid()) {
            this.ModLoader.gui.setDiscordStatus(
                new DiscordStatus(
                    'Playing WWOnline',
                    'In ' +
                    this.clientStorage.localization[
                    scene
                    ]
                )
            );
        }
    }

    @EventHandler(WWEvents.ON_ROOM_CHANGE)
    onRoomChange(scene: string, room: number) {
        //Log when the player changes to a different island
        if (scene === "sea") {
            if (room !== 0 && room !== 0xFF) {
                this.ModLoader.clientSide.sendPacket(
                    new WWO_RoomPacket(
                        this.ModLoader.clientLobby,
                        scene,
                        room
                    )
                );
                this.ModLoader.logger.info('client: I moved to ' + (this.clientStorage.localization_island[room] || room) + '.');
            }
        }
    }

    @NetworkHandler('WWO_ScenePacket')
    onSceneChange_client(packet: WWO_ScenePacket) {
        this.ModLoader.logger.info(
            'client receive: Player ' +
            packet.player.nickname +
            ' moved to scene ' +
            this.clientStorage.localization[
            packet.scene
            ] +
            '.'
        );
        bus.emit(
            WWOEvents.CLIENT_REMOTE_PLAYER_CHANGED_SCENES,
            new WWOPlayerScene(packet.player, packet.lobby, packet.scene)
        );
    }

    @NetworkHandler('WWO_RoomPacket')
    onRoomChange_client(packet: WWO_RoomPacket) {
        if (packet.scene === "sea" && packet.room !== 0) {
            this.ModLoader.logger.info(
                'client receive: Player ' +
                packet.player.nickname +
                ' moved to ' +
                this.clientStorage.localization_island[
                packet.room
                ] +
                '.'
            );
        }
        bus.emit(
            WWOEvents.CLIENT_REMOTE_PLAYER_CHANGED_SCENES,
            new WWOPlayerScene(packet.player, packet.lobby, packet.scene)
        );
    }

    // This packet is basically 'where the hell are you?' if a player has a puppet on file but doesn't know what scene its suppose to be in.
    @NetworkHandler('WWO_SceneRequestPacket')
    onSceneRequest_client(packet: WWO_SceneRequestPacket) {
        if (this.core.save !== undefined) {
            this.ModLoader.clientSide.sendPacketToSpecificPlayer(
                new WWO_ScenePacket(
                    this.ModLoader.clientLobby,
                    this.core.global.current_scene_name
                ),
                packet.player
            );
        }
    }

    @NetworkHandler('WWO_BottleUpdatePacket')
    onBottle_client(packet: WWO_BottleUpdatePacket) {
        if (
            this.core.helper.isTitleScreen() ||
            !this.core.helper.isSceneNameValid()
        ) {
            return;
        }
        if (packet.player.data.world !== this.clientStorage.world) return;
        let inventory = this.core.save.inventory;
        if (packet.contents === InventoryItem.NONE) return;
        this.clientStorage.bottleCache[packet.slot] = packet.contents;
        switch (packet.slot) {
            case 0:
                inventory.FIELD_BOTTLE1 = packet.contents;
                break;
            case 1:
                inventory.FIELD_BOTTLE2 = packet.contents;
                break;
            case 2:
                inventory.FIELD_BOTTLE3 = packet.contents;
                break;
            case 3:
                inventory.FIELD_BOTTLE4 = packet.contents;
                break;
        }
        if (packet.contents === InventoryItem.BOTTLE_FOREST_WATER && this.ModLoader.emulator.rdramRead16(0x803C4C6E) === 0) this.ModLoader.emulator.rdramWrite16(0x803C4C6E, 0x8CA0); //Forest Water Timer 
        bus.emit(WWOEvents.ON_INVENTORY_UPDATE, this.core.save.inventory);
        // Update hash.
        this.clientStorage.saveManager.createSave();
        this.clientStorage.lastPushHash = this.clientStorage.saveManager.hash;
    }

    private isBottle(item: InventoryItem) {
        return (item >= InventoryItem.BOTTLE_EMPTY && item <= InventoryItem.BOTTLE_FOREST_WATER)
    }

    healPlayer() {
        if (this.core.helper.isTitleScreen() || !this.core.helper.isSceneNameValid()) return;
        this.core.ModLoader.emulator.rdramWriteF32(0x803CA764, 80); //Number of quarter hearts to add to the player's HP this frame. Can be negative to damage the player.
    }

    @EventHandler(WWOEvents.GAINED_PIECE_OF_HEART)
    onNeedsHeal(evt: any) {
        this.healPlayer();
    }

    @EventHandler(WWOEvents.MAGIC_METER_INCREASED)
    onNeedsMagic(size: API.MagicQuantities) {
        switch (size) {
            case API.MagicQuantities.NONE:
                console.log("Magic Meter NONE")
                this.core.save.questStatus.current_mp += API.MagicQuantities.NONE;
                break;
            case API.MagicQuantities.NORMAL:
                console.log("Magic Meter NORMAL")
                this.core.save.questStatus.current_mp += API.MagicQuantities.NORMAL;
                break;
            case API.MagicQuantities.EXTENDED:
                console.log("Magic Meter Extended")
                this.core.save.questStatus.current_mp += API.MagicQuantities.EXTENDED;
                break;
        }
    }

    // The server is giving me data.
    @NetworkHandler('WWO_DownloadResponsePacket')
    onDownloadPacket_client(packet: WWO_DownloadResponsePacket) {
        this.syncPending = false;
        if (
            this.core.helper.isTitleScreen() ||
            !this.core.helper.isSceneNameValid()
        ) {
            return;
        }
        if (!packet.host) {
            if (packet.save) {
                this.clientStorage.saveManager.forceOverrideSave(packet.save!, this.core.save as any, ProxySide.CLIENT);
                //this.clientStorage.saveManager.processKeyRing_OVERWRITE(packet.keys!, this.clientStorage.saveManager.createKeyRing(), ProxySide.CLIENT);
                // Update hash.
                this.clientStorage.saveManager.createSave();
                this.clientStorage.lastPushHash = this.clientStorage.saveManager.hash;
            }
        } else {
            this.ModLoader.logger.info("The lobby is mine!");
        }
        this.ModLoader.utils.setTimeoutFrames(() => {
            this.clientStorage.first_time_sync = true;
            this.updateBottles(true);
        }, 20);
    }

    @NetworkHandler('WWO_UpdateSaveDataPacket')
    onSaveUpdate(packet: WWO_UpdateSaveDataPacket) {
        if (
            this.core.helper.isTitleScreen() ||
            !this.core.helper.isSceneNameValid()
        ) {
            //console.log("onSaveUpdate Failure 0")
            return;
        }
        if (packet.world !== this.clientStorage.world) {
            //console.log("onSaveUpdate Failure 1")
            return;
        }

        this.clientStorage.saveManager.applySave(packet.save);
        // Update hash.
        this.clientStorage.saveManager.createSave();
        this.clientStorage.lastPushHash = this.clientStorage.saveManager.hash;
    }

    @NetworkHandler('WWO_FlagUpdate')
    onFlagUpdate(packet: WWO_FlagUpdate) {
        if (
            this.core.helper.isTitleScreen() ||
            !this.core.helper.isSceneNameValid() ||
            this.core.helper.isLoadingZone()
        ) {
            return;
        }
        console.log("onFlagUpdate Client");

        for (let i = 0; i < packet.eventFlags.byteLength; i++) {
            if (packet.eventFlags[i] !== this.clientStorage.eventFlags[i]) {
                console.log(`Writing flag: 0x${i.toString(16)}, storage: 0x${this.clientStorage.eventFlags[i].toString(16)}, incoming: 0x${packet.eventFlags[i].toString(16)} `);
            }
        }
        let eventFlags = this.clientStorage.eventFlags;
        parseFlagChanges(packet.eventFlags, eventFlags);
        this.clientStorage.eventFlags = eventFlags;
        this.core.save.eventFlags = this.clientStorage.eventFlags;
    }

    @NetworkHandler('WWO_ClientSceneContextUpdate')
    onSceneContextSync_client(packet: WWO_ClientSceneContextUpdate) {
        if (
            this.core.helper.isTitleScreen() ||
            !this.core.helper.isSceneNameValid() ||
            this.core.helper.isLoadingZone()
        ) {
            return;
        }
        if (packet.world !== this.clientStorage.world) return;

        let stage = new StageInfo(this.ModLoader.emulator, packet.id);
        let chests = stage.chests;
        let switches = stage.switches;
        let items = stage.items;
        let rooms = stage.rooms;

        parseFlagChanges(packet.stage.chests, chests);
        parseFlagChanges(packet.stage.switches, switches);
        parseFlagChanges(packet.stage.items, items);
        parseFlagChanges(packet.stage.rooms, rooms);

        stage.chests = chests;
        stage.switches = switches;
        stage.items = items;
        stage.rooms = rooms;
        stage.keys = packet.stage.keys;
        stage.map = packet.stage.map;
        stage.compass = packet.stage.compass;
        stage.bigKey = packet.stage.bigKey;
        stage.bossKilled = packet.stage.bossKilled;
        stage.heartTaken = packet.stage.heartTaken;
        stage.bossIntroWatched = packet.stage.bossIntroWatched;

        if (this.core.global.current_stage_id === packet.id) {
            let buf1: Buffer = this.core.save.stage_Live.chests;
            if (Object.keys(parseFlagChanges(packet.stage.chests, buf1) > 0)) {
                this.core.save.stage_Live.chests = buf1;
            }

            let buf2: Buffer = this.core.save.stage_Live.switches;
            if (Object.keys(parseFlagChanges(packet.stage.switches, buf2) > 0)) {
                this.core.save.stage_Live.switches = buf2;
            }

            let buf3: Buffer = this.core.save.stage_Live.items;
            if (Object.keys(parseFlagChanges(packet.stage.items, buf3) > 0)) {
                this.core.save.stage_Live.items = buf3;
            }
            let buf4: Buffer = this.core.save.stage_Live.rooms;
            if (Object.keys(parseFlagChanges(packet.stage.rooms, buf4) > 0)) {
                this.core.save.stage_Live.rooms = buf4;
            }
            if (packet.stage.keys !== this.core.save.stage_Live.keys) {
                this.core.save.stage_Live.keys = packet.stage.keys;
            }
            if (packet.stage.map) {
                this.core.save.stage_Live.map = packet.stage.map;
            }
            if (packet.stage.compass) {
                this.core.save.stage_Live.compass = packet.stage.compass;
            }
            if (packet.stage.bigKey) {
                this.core.save.stage_Live.bigKey = packet.stage.bigKey;
            }
            if (packet.stage.bossKilled) {
                this.core.save.stage_Live.bossKilled = packet.stage.bossKilled;
            }
            if (packet.stage.heartTaken) {
                this.core.save.stage_Live.heartTaken = packet.stage.heartTaken;
            }
            if (packet.stage.bossIntroWatched) {
                this.core.save.stage_Live.bossIntroWatched = packet.stage.bossIntroWatched;
            }
            // Update hash.
            this.clientStorage.saveManager.createSave();
            this.clientStorage.lastPushHash = this.clientStorage.saveManager.hash;
        }
    }
    /* @NetworkHandler('WWO_RupeePacket')
    onRupees(packet: WWO_RupeePacket) {
        if (!this.sentRupees) {
            this.core.save.inventory.rupeeCount += packet.delta;
            console.log(`onRupees: ${packet.delta}, rupeeCount: ${this.core.save.inventory.rupeeCount}`)
        }
        else { 
            console.log(`I sent these! Refusing...`);
            this.sentRupees = false;
        }
        this.lastRupees = this.core.save.inventory.rupeeCount;
    } */

    @NetworkHandler('WWO_ErrorPacket')
    onError(packet: WWO_ErrorPacket) {
        this.ModLoader.logger.error(packet.message);
    }

    @onTick()
    onTick() {
        if (
            !this.core.helper.isTitleScreen() &&
            this.core.helper.isSceneNameValid()
        ) {
            if (!this.core.helper.isPaused()) {
                this.ModLoader.me.data["world"] = this.clientStorage.world;
                if (!this.clientStorage.first_time_sync) {
                    return;
                }
                if (this.LobbyConfig.data_syncing) {
                    this.autosaveSceneData();
                    this.updateBottles();
                    //this.updateRupees();
                    this.syncTimer++;
                }
            }
        }
    }

    inventoryUpdateTick() {
        this.updateInventory();
        this.updateFlags();
    }
}
