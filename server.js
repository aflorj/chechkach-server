import express from 'express';
import http from 'http';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import redis from 'redis';
import { Repository, Schema } from 'redis-om';
import words from './words.json' assert { type: 'json' };

const selectNRandomWords = (n) => {
  const selectedIndexes = new Set();
  const result = [];

  while (selectedIndexes.size < n) {
    const randomIndex = Math.floor(Math.random() * words.length);
    if (!selectedIndexes.has(randomIndex)) {
      selectedIndexes.add(randomIndex);
      result.push(words[randomIndex]);
    }
  }

  console.log('user can choose to draw one of these: ', ...result);
  return result;
};

const lobbySchema = new Schema('lobby', {
  name: { type: 'string' },
  status: { type: 'string' },
  playersIds: { type: 'string[]', path: '$.players[*].playerId' },
  playersSocketIds: { type: 'string[]', path: '$.players[*].socketId' },
});

const app = express();
const server = http.createServer(app);
const socketIO = new Server(server, {
  cors: {
    origin: '*',
  },
});

const redisClient = redis.createClient({ url: 'redis://localhost:9911' });

const lobbyRepository = new Repository(lobbySchema, redisClient);

redisClient
  .connect()
  .then((res) => {
    console.log('Redis connect success: ', res);
  })
  .catch((err) => {
    console.error('Redis no connect: ', err);
  });

redisClient.on('ready', () => {
  console.log('Redis ready - Connected!');
  lobbyRepository
    .createIndex()
    .then((res) => {
      console.log('create index res: ', res);
    })
    .catch((err) => {
      console.log('create index error res: ', err);
    });
});

redisClient.on('error', (err) => {
  console.error('redis error: ', err);
});

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 9030;

// WebSocket server logic
socketIO.on('connection', (socket) => {
  console.log('WebSocket client connected: ', socket?.id);

  socket.on('join', ({ lobbyName, userName }) => {
    // join the socket and lobby if it exist or return an error if it doesn't

    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnAll()
      .then((response) => {
        if (response?.length === 0) {
          // lobby that we are trying to join doesn't exist - return an error
          // TODO ne vem tocno ki tu nrdit
          // res.status(404).json({
          //   message: `Lobby "${lobbyName}" doesn't exist.`,
          // });
        } else {
          // lobbby with this name exists

          // we join the socket
          socket.join(lobbyName);

          // and we join the lobby
          let lobbyToJoin = response?.[0];
          let oldPlayers = lobbyToJoin?.players;
          lobbyToJoin.players = [
            ...oldPlayers,
            {
              playerId: userName,
              socketId: socket?.id,
              connected: true,
              isOwner: lobbyToJoin?.players?.length === 0 ? true : false, // become lobby owner if you are joing an empty lobby
              // ready: false, CHANGE: we don't track players status anymore
            },
          ];

          lobbyRepository
            .save(lobbyToJoin)
            .then((ljRes) => {
              console.log('lobbyJoinResponse: ', ljRes);

              // emit the 'starting' lobby state as a 'lobbyUpdate' to all players in the lobby
              socketIO.to(lobbyName).emit('lobbyUpdate', {
                newLobbyState: ljRes,
              });
            })
            .catch((err) => {
              console.log('lobbyJoin error: ', err);
            });
        }
      })
      .catch((err) => {
        console.log('error pri iskanju 333: ', err);
      });

    // ce bom kje rabu socketId
    // lobbies.get(lobbyName).push({
    //   socketId: socket?.id,
    //   userName: userName,
    // });

    socketIO.to(lobbyName).emit('message', {
      message: {
        type: 'playerJoiningOrLeaving',
        content: `Player ${userName} joined the lobby.`,
      },
      userName: 'server',
      serverMessage: true,
    });

    // console.log('lobbies after join: ', lobbies);
    console.log('all rooms after connect: ', socketIO?.sockets?.adapter?.rooms);
  });

  socket.on(
    'message',
    ({ userName, lobbyName, messageType, messageContent }) => {
      // // Broadcast the message to all sockets in the same rooms

      socketIO.to(lobbyName).emit('message', {
        userName: userName,
        message: { type: messageType, content: messageContent },
        serverMessage: false,
      });
    }
  );

  // CHANGE: We don't track player's status anymore
  // socket.on('ready_change', ({ userName, lobbyName, isReady }) => {
  //   console.log(
  //     `User ${userName} in lobbby ${lobbyName} changed status to ${isReady}`
  //   );

  //   // spememba ready statusa in prenos tega sporocila na lobby
  //   lobbyRepository
  //     .search()
  //     .where('name')
  //     .equals(lobbyName)
  //     .returnFirst()
  //     .then((ourLobby) => {
  //       console.log('ulres: ', ourLobby);
  //       // find index of our player in the lobby
  //       let tempLobby = ourLobby;
  //       let playerIndex = tempLobby?.players?.findIndex(
  //         (player) => player?.playerId === userName
  //       );
  //       tempLobby.players[playerIndex].ready = isReady;

  //       // check if this ready change puts all (both) players into 'ready' state and start the game
  //       if (
  //         isReady &&
  //         tempLobby?.players?.filter((player) => player?.ready)?.length === 2
  //       ) {
  //         // TODO not hardcoded but based on lobbysize
  //         tempLobby.status = 'playing';
  //       }

  //       lobbyRepository
  //         .save(tempLobby)
  //         .then((saveres) => {
  //           console.log('save res: ', saveres);

  //           // emit new lobby state as a 'lobbyUpdate' to all players in the lobby
  //           socketIO.to(lobbyName).emit('lobbyUpdate', {
  //             newLobbyState: saveres,
  //           });
  //         })
  //         .catch((saverr) => {
  //           console.log('save err: ', saverr);
  //         });
  //     })
  //     .catch((err) => {
  //       console.log('elerr: ', err);
  //     });
  // });

  socket.on('startGame', ({ userName, lobbyName }) => {
    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        console.log('ulres: ', ourLobby);
        // find index of our player in the lobby
        let tempLobby = ourLobby;
        let playerIndex = tempLobby?.players?.findIndex(
          (player) => player?.playerId === userName
        );

        // check if the player even has the permission to strat the game (isOwner === true)
        if (tempLobby.players[playerIndex].isOwner) {
          // they are the owner - start
          console.log('the owner of the lobby started the game');

          // starting the game
          tempLobby.status = 'pickingWord';
          let wordsToPickFrom = selectNRandomWords(3);

          let drawerSocketId = tempLobby.players[playerIndex].socketId;
          socketIO.to(drawerSocketId).emit('pickAWord', {
            arrayOfWordOptions: wordsToPickFrom,
          });
        } else {
          // no permission to start the game
        }

        lobbyRepository
          .save(tempLobby)
          .then((saveres) => {
            console.log('save res: ', saveres);

            // emit new lobby state as a 'lobbyUpdate' to all players in the lobby
            socketIO.to(lobbyName).emit('lobbyUpdate', {
              newLobbyState: saveres,
            });
          })
          .catch((saverr) => {
            console.log('save err: ', saverr);
          });
      })
      .catch((err) => {
        console.log('elerr: ', err);
      });
  });

  socket.on('draw', ({ newLine, lobbyName }) => {
    // update redis?
    // TODO

    // emit new paths as a 'newLine' to all players in the lobby except the person drawing
    socket.to(lobbyName).emit('newLine', {
      newLine: newLine,
    });
  });

  socket.on('disconnect', () => {
    console.log(`Disconnect msg coming from socketid ${socket?.id}`);

    lobbyRepository
      .search()
      .where('playersSocketIds')
      .contain(socket?.id)
      .return.first()
      .then((r) => {
        console.log('to je leaval: ', r);

        if (r?.status === 'open') {
          // if the status of the lobby equals 'open' we remove the player on disconnect
          // doing
          let tempLobby = r;
          let playerIndex = tempLobby?.players?.findIndex(
            (player) => player?.socketId === socket?.id
          );
          tempLobby?.players?.splice?.(playerIndex, 1);

          lobbyRepository
            .save(tempLobby)
            .then((dcsr) => {
              console.log('save on disconnect response: ', dcsr);

              // emit the new lobby state as a 'lobbyUpdate' to all players in the lobby
              socketIO.to(r?.name).emit('lobbyUpdate', {
                newLobbyState: dcsr,
              });
            })
            .catch((dcserr) => {
              console.log('save on disconnect error: ', dcserr);
            });
        }

        // if the game is active, we don't (immediately) remove them?
      })
      .catch((err) => {
        console.log('liv eror: ', err);
      });
    // using socketId, find the lobby user has left

    console.log('all rooms after dc: ', socketIO?.sockets?.adapter?.rooms);
  });

  socket.on('disconnect_details', ({ userName, lobbyName }) => {
    console.log(`username: ${userName} and lobbyName: ${lobbyName}`);
  });
});

app.get('/api/getAllLobbies', function (req, res) {
  lobbyRepository
    .search()
    .return.all()
    .then((resp) => {
      console.log('vsi lobiji res na serverju: ', resp);
      if (resp?.length > 0) {
        // obstajajo lobiji
        const lobbiesArray = [];
        resp?.forEach((lobby) => {
          lobbiesArray.push({
            name: lobby?.name,
            status: lobby?.status,
            players: lobby?.players,
          });
        });
        res.status(200).json({
          lobbies: lobbiesArray,
        });
      } else {
        res.status(404).json({
          message: 'No lobbies found.',
        });
      }
    })
    .catch((err) => {
      console.log('error pri vseh lobijih na serveju: ', err);
    });
  // res.send(lobbiesArray);
});

app.get('/api/getLobby/:id', function (req, res) {
  const lobbyName = req?.params?.id;

  lobbyRepository
    .search()
    .where('name')
    .equals(lobbyName)
    .returnAll()
    .then((response) => {
      if (response?.length === 0) {
        // lobby doesn't exist
        console.log(`lobby ${lobbyName} doesn't exist`);
        res.status(404).json({
          message: `Lobby ${lobbyName} doesn't exist`,
        });
      } else {
        console.log(`lobby ${lobbyName} exist`);
        res.status(200).json({
          lobbyInfo: response[0],
        });
      }
    })
    .catch((err) => {
      console.log('error pri iskanju111111111: ', err);
    });
});

app.post('/api/joinLobby', function (req, res) {
  const lobbyName = req?.body?.lobbyName;

  // logika za preverjanje ustvarjanja lobbyja - lobby s tem imenom se ne obstaja
  lobbyRepository
    .search()
    .where('name')
    .equals(lobbyName)
    .returnAll()
    .then((response) => {
      if (response?.length === 0) {
        // lobby doesn't exist
        console.log(`lobby ${lobbyName} doesn't exist`);
        res.status(404).json({
          message: `Lobby ${lobbyName} doesn't exist`,
        });
      } else {
        // lobbby exists and we can join

        //  TODO  full lobby, password, active game,...
        console.log(`lobby ${lobbyName} exist`);
        res.status(200).json({
          message: `You can join ${lobbyName}`,
          lobbyInfo: response[0],
        });
      }
    })
    .catch((err) => {
      console.log('error pri iskanju123123: ', err);
    });
});

app.post('/api/createLobby', function (req, res) {
  const lobbyName = req?.body?.lobbyName;

  // logika za preverjanje ustvarjanja lobbyja - lobby s tem imenom se ne obstaja
  lobbyRepository
    .search()
    .where('name')
    .equals(lobbyName)
    .returnAll()
    .then((response) => {
      if (response?.length === 0) {
        // lobby doesn't exist yet - create it
        lobbyRepository
          .save({
            name: lobbyName,
            status: 'open',
            players: [],
          })
          .then((resp) => {
            console.log('lobby creation response: ', resp);
            // lobby successfully created on redis
            res.status(201).json({
              lobbyName: lobbyName,
              message: `Lobby ${lobbyName} successfully created.`,
            });
          })
          .catch((err) => {
            console.log('lobby creation error: ', err);
          });
      } else {
        // lobbby with this name already exists
        console.log(`server ${lobbyName} ze obstaja`);
        res.status(400).json({
          message: `Lobby with name "${lobbyName}" alerady exists.`,
        });
      }
    })
    .catch((err) => {
      console.log('error pri iskanju 222: ', err);
    });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
