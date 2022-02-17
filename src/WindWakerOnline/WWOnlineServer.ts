import { WWO_PRIVATE_EVENTS } from "./api/InternalAPI";
import { WWOEvents, WWOPlayerScene } from "./api/WWOAPI";
import { InjectCore } from "modloader64_api/CoreInjection";
import { EventHandler, EventsServer, EventServerJoined, EventServerLeft, bus } from "modloader64_api/EventHandler";
import { IModLoaderAPI, IPlugin } from "modloader64_api/IModLoaderAPI";
import { ModLoaderAPIInject } from "modloader64_api/ModLoaderAPIInjector";
import { IPacketHeader, LobbyData, ServerNetworkHandler } from "modloader64_api/NetworkHandler";
import { Preinit } from "modloader64_api/PluginLifecycle";
import { ParentReference, SidedProxy, ProxySide } from "modloader64_api/SidedProxy/SidedProxy";
import { WWO_ScenePacket, WWO_DownloadRequestPacket, WWO_DownloadResponsePacket, WWO_UpdateSaveDataPacket, WWO_ErrorPacket, WWO_ClientFlagUpdate, WWO_ServerFlagUpdate, WWO_RoomPacket } from "./network/WWOPackets";
import { WWOSaveData } from "./save/WWOnlineSaveData";
import { WWOnlineStorage, WWOnlineSave_Server } from "./storage/WWOnlineStorage";
import WWSerialize from "./storage/WWSerialize";
import { IWWCore } from "WindWaker/API/WWAPI";

export default class WWOnlineServer {

    @InjectCore()
    core!: IWWCore;
    @ModLoaderAPIInject()
    ModLoader!: IModLoaderAPI;
    @ParentReference()
    parent!: IPlugin;

    chao_data() { return 0 }

    sendPacketToPlayersInScene(packet: IPacketHeader) {
        try {
            let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
                packet.lobby,
                this.parent
            ) as WWOnlineStorage;
            if (storage === null) {
                return;
            }
            Object.keys(storage.players).forEach((key: string) => {
                if (storage.players[key] === storage.players[packet.player.uuid]) {
                    if (storage.networkPlayerInstances[key].uuid !== packet.player.uuid) {
                        this.ModLoader.serverSide.sendPacketToSpecificPlayer(
                            packet,
                            storage.networkPlayerInstances[key]
                        );
                    }
                }
            });
        } catch (err: any) { }
    }

    @EventHandler(EventsServer.ON_LOBBY_CREATE)
    onLobbyCreated(lobby: string) {
        try {
            this.ModLoader.lobbyManager.createLobbyStorage(lobby, this.parent, new WWOnlineStorage());
            let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
                lobby,
                this.parent
            ) as WWOnlineStorage;
            if (storage === null) {
                return;
            }
            storage.saveManager = new WWOSaveData(this.core, this.ModLoader);
        }
        catch (err: any) {
            this.ModLoader.logger.error(err);
        }
    }

    @Preinit()
    preinit() {

    }

    @EventHandler(EventsServer.ON_LOBBY_DATA)
    onLobbyData(ld: LobbyData) {
    }

    @EventHandler(EventsServer.ON_LOBBY_JOIN)
    onPlayerJoin_server(evt: EventServerJoined) {
        let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
            evt.lobby,
            this.parent
        ) as WWOnlineStorage;
        if (storage === null) {
            return;
        }
        storage.players[evt.player.uuid] = -1;
        storage.networkPlayerInstances[evt.player.uuid] = evt.player;
    }

    @EventHandler(EventsServer.ON_LOBBY_LEAVE)
    onPlayerLeft_server(evt: EventServerLeft) {
        let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
            evt.lobby,
            this.parent
        ) as WWOnlineStorage;
        if (storage === null) {
            return;
        }
        delete storage.players[evt.player.uuid];
        delete storage.networkPlayerInstances[evt.player.uuid];
    }

    @ServerNetworkHandler('WWO_ScenePacket')
    onSceneChange_server(packet: WWO_ScenePacket) {
        try {
            let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
                packet.lobby,
                this.parent
            ) as WWOnlineStorage;
            if (storage === null) {
                return;
            }
            storage.players[packet.player.uuid] = packet.scene;
            this.ModLoader.logger.info(
                'Server: Player ' +
                packet.player.nickname +
                ' moved to scene ' +
                packet.scene +
                '.'
            );
            bus.emit(WWOEvents.SERVER_PLAYER_CHANGED_SCENES, new WWO_ScenePacket(packet.lobby, packet.scene));
        } catch (err: any) {
        }
    }

    @ServerNetworkHandler('WWO_RoomPacket')
    onRoomChange_server(packet: WWO_RoomPacket) {
        try {
            let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
                packet.lobby,
                this.parent
            ) as WWOnlineStorage;
            if (storage === null) {
                return;
            }
            storage.players[packet.player.uuid] = packet.room;
            this.ModLoader.logger.info(
                'Server: Player ' +
                packet.player.nickname +
                ' moved to room ' +
                packet.room +
                '.'
            );
            bus.emit(WWOEvents.SERVER_PLAYER_CHANGED_ROOMS, new WWO_RoomPacket(packet.lobby, packet.scene, packet.room));
        } catch (err: any) {
        }
    }

    // Client is logging in and wants to know how to proceed.
    @ServerNetworkHandler('WWO_DownloadRequestPacket')
    onDownloadPacket_server(packet: WWO_DownloadRequestPacket) {
        let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
            packet.lobby,
            this.parent
        ) as WWOnlineStorage;
        if (storage === null) {
            return;
        }
        if (typeof storage.worlds[packet.player.data.world] === 'undefined') {
            this.ModLoader.logger.info(`Creating world ${packet.player.data.world} for lobby ${packet.lobby}.`);
            storage.worlds[packet.player.data.world] = new WWOnlineSave_Server();
        }
        let world = storage.worlds[packet.player.data.world];
        if (world.saveGameSetup) {
            // Game is running, get data.
            let resp = new WWO_DownloadResponsePacket(packet.lobby, false);
            WWSerialize.serialize(world.save).then((buf: Buffer) => {
                resp.save = buf;
                this.ModLoader.serverSide.sendPacketToSpecificPlayer(resp, packet.player);
            }).catch((err: string) => { });
        } else {
            // Game is not running, give me your data.
            WWSerialize.deserialize(packet.save).then((data: any) => {
                Object.keys(data).forEach((key: string) => {
                    let obj = data[key];
                    world.save[key] = obj;
                });
                world.saveGameSetup = true;
                let resp = new WWO_DownloadResponsePacket(packet.lobby, true);
                this.ModLoader.serverSide.sendPacketToSpecificPlayer(resp, packet.player);
            });
        }
    }

    //------------------------------
    // Flag Syncing
    //------------------------------

    @ServerNetworkHandler('WWO_UpdateSaveDataPacket')
    onSceneFlagSync_server(packet: WWO_UpdateSaveDataPacket) {
        let storage: WWOnlineStorage = this.ModLoader.lobbyManager.getLobbyStorage(
            packet.lobby,
            this.parent
        ) as WWOnlineStorage;
        if (storage === null) {
            return;
        }
        if (typeof storage.worlds[packet.player.data.world] === 'undefined') {
            if (packet.player.data.world === undefined) {
                this.ModLoader.serverSide.sendPacket(new WWO_ErrorPacket("The server has encountered an error with your world. (world id is undefined)", packet.lobby));
                return;
            } else {
                storage.worlds[packet.player.data.world] = new WWOnlineSave_Server();
            }
        }
        let world = storage.worlds[packet.player.data.world];
        storage.saveManager.mergeSave(packet.save, world.save, ProxySide.SERVER).then((bool: boolean) => {
            if (bool) {
                WWSerialize.serialize(world.save).then((buf: Buffer) => {
                    this.ModLoader.serverSide.sendPacket(new WWO_UpdateSaveDataPacket(packet.lobby, buf, packet.player.data.world));
                }).catch((err: string) => { });
            }
        });
    }
}