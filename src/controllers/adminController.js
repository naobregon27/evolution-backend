import User from '../models/User.js';
import Local from '../models/Local.js';
import logger from '../config/logger.js';
import mongoose from 'mongoose';

// Cantidad máxima de superAdmins permitidos
const MAX_SUPER_ADMINS = 4;

// Obtener todos los usuarios (para admin y superAdmin)
export const getAllUsers = async (req, res) => {
  try {
    // Parámetros de paginación
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    // Parámetros de filtrado
    const filters = {};
    
    if (req.query.role) filters.role = req.query.role;
    if (req.query.activo === 'true') filters.activo = true;
    if (req.query.activo === 'false') filters.activo = false;
    if (req.query.search) {
      filters.$or = [
        { nombre: { $regex: req.query.search, $options: 'i' } },
        { email: { $regex: req.query.search, $options: 'i' } }
      ];
    }
    if (req.query.local) {
      // Buscar usuarios que pertenezcan a este local
      filters.locales = req.query.local;
    }
    
    // Si el usuario es admin, restringir la vista a sus locales y no mostrar superAdmins
    if (req.userRole === 'admin') {
      if (req.user.locales && req.user.locales.length > 0) {
        // Mostrar usuarios que pertenezcan a cualquiera de los locales del admin
        filters.locales = { $in: req.user.locales };
      }
      filters.role = { $ne: 'superAdmin' };
    }
    
    // Contar total de registros para la paginación primero
    const total = await User.countDocuments(filters);
    
    // Configurar query con includeInactive antes de find() para asegurar que funcione correctamente
    const findQuery = { ...filters };
    const options = { includeInactive: true }; // Asegurar incluir usuarios inactivos
    
    // Realizar búsqueda con todas las opciones
    const users = await User.find(findQuery, null, options)
      .select('-password')
      .populate('locales', 'nombre direccion telefono email')
      .populate('localPrincipal', 'nombre direccion')
      .populate('creadoPor', 'nombre email')
      .populate('ultimaModificacion.usuario', 'nombre email')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 })
      .lean(); // Usar lean() para mejorar rendimiento y obtener objetos JS planos
    
    // Obtener conteo de usuarios por local para administradores
    const localUserCounts = {};
    
    // Sólo realizar el conteo cuando es relevante (para admins y superAdmins)
    if (req.userRole === 'admin' || req.userRole === 'superAdmin') {
      // Obtener los IDs de locales únicos de la lista de usuarios
      const localIds = [...new Set(users
        .filter(user => user.locales && user.locales.length > 0 && user.role === 'admin')
        .flatMap(user => user.locales.map(local => local._id.toString())))];
        
      // Para cada local, contar sus usuarios regulares
      for (const localId of localIds) {
        const count = await User.countDocuments({
          locales: localId,
          role: 'usuario',
          activo: true,
          includeInactive: false
        });
        localUserCounts[localId] = count;
      }
      
      // Si es admin, obtener el conteo específico para sus locales
      if (req.userRole === 'admin' && req.user.locales && req.user.locales.length > 0) {
        for (const adminLocal of req.user.locales) {
          const adminLocalId = adminLocal.toString();
          if (!localUserCounts[adminLocalId]) {
            localUserCounts[adminLocalId] = await User.countDocuments({
              locales: adminLocalId,
              role: 'usuario',
              activo: true
            });
          }
        }
      }
    }
    
    // Modificar la respuesta para mostrar todos los usuarios en formato plano
    const usersData = users.map(user => {
      // Obtener el conteo de usuarios para este local si es admin
      let usuariosEnLocal = null;
      if (user.role === 'admin' && user.locales && user.locales.length > 0) {
        // Sumar usuarios de todos los locales que administra
        usuariosEnLocal = user.locales.reduce((sum, local) => {
          const localId = local._id.toString();
          return sum + (localUserCounts[localId] || 0);
        }, 0);
      }
      
      return {
        id: user._id.toString(),
        nombre: user.nombre,
        email: user.email,
        role: user.role,
        telefono: user.telefono || '',
        direccion: user.direccion || '',
        organizacion: user.organizacion || '',
        permisos: user.permisos || {},
        esAdministradorLocal: user.esAdministradorLocal || false,
        locales: user.locales ? user.locales.map(local => ({
          id: local._id?.toString(),
          nombre: local.nombre,
          direccion: local.direccion,
          telefono: local.telefono,
          email: local.email
        })) : [],
        localPrincipal: user.localPrincipal ? {
          id: user.localPrincipal._id?.toString(),
          nombre: user.localPrincipal.nombre,
          direccion: user.localPrincipal.direccion
        } : null,
        imagenPerfil: user.imagenPerfil,
        verificado: user.verificado,
        activo: user.activo,
        enLinea: user.enLinea,
        fechaCreacion: user.createdAt,
        fechaActualizacion: user.updatedAt,
        ultimaConexion: user.ultimaConexion,
        creadoPor: user.creadoPor ? {
          id: user.creadoPor._id?.toString(),
          nombre: user.creadoPor.nombre,
          email: user.creadoPor.email
        } : null,
        ultimaModificacion: user.ultimaModificacion ? {
          usuario: user.ultimaModificacion.usuario ? {
            id: user.ultimaModificacion.usuario._id?.toString(),
            nombre: user.ultimaModificacion.usuario.nombre,
            email: user.ultimaModificacion.usuario.email
          } : null,
          fecha: user.ultimaModificacion.fecha
        } : null,
        // Añadir el conteo directamente en el usuario si es admin
        usuariosEnLocal: user.role === 'admin' ? usuariosEnLocal : undefined
      };
    });
    
    // Respuesta con los usuarios completos
    res.status(200).json({
      success: true,
      data: {
        users: usersData,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    logger.error(`Error obteniendo usuarios: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener usuarios',
      error: error.message 
    });
  }
};

// Obtener un usuario por ID
export const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId)
      .select('-password')
      .populate('locales', 'nombre direccion telefono email')
      .populate('localPrincipal', 'nombre direccion')
      .populate('creadoPor', 'nombre email')
      .populate('ultimaModificacion.usuario', 'nombre email');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    // Verificar permisos: un admin no puede ver detalles de un superAdmin
    if (req.userRole === 'admin') {
      // No puede ver superAdmins
      if (user.role === 'superAdmin') {
        return res.status(403).json({
          success: false,
          message: 'No tiene permisos para ver este usuario'
        });
      }
      
      // Solo puede ver usuarios que pertenezcan a alguno de sus locales
      const tienePermisos = user.locales && user.locales.some(local => 
        req.user.locales && req.user.locales.some(adminLocal => 
          adminLocal.toString() === local.toString()
        )
      );
      
      if (!tienePermisos) {
        return res.status(403).json({
          success: false,
          message: 'No tiene permisos para ver este usuario'
        });
      }
    }
    
    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error) {
    logger.error(`Error obteniendo usuario: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener usuario',
      error: error.message 
    });
  }
};

// Crear un nuevo usuario (admin o superAdmin pueden hacer esto)
export const createUser = async (req, res) => {
  try {
    const { nombre, email, password, role, telefono, direccion, organizacion, locales } = req.body;
    
    // Verificar límite de superAdmins si se está creando uno nuevo
    if (role === 'superAdmin') {
      const superAdminsCount = await User.countDocuments({ role: 'superAdmin' });
      if (superAdminsCount >= MAX_SUPER_ADMINS) {
        return res.status(400).json({
          success: false,
          message: `No se pueden crear más de ${MAX_SUPER_ADMINS} superAdmins en el sistema`
        });
      }
    }
    
    // Si el usuario es admin, solo puede crear usuarios regulares en sus locales
    if (req.userRole === 'admin') {
      // No puede crear administradores
      if (role && role !== 'usuario') {
        return res.status(403).json({
          success: false,
          message: 'No tiene permisos para crear usuarios con este rol'
        });
      }
      
      // Si se especifican locales, verificar que pertenezcan al admin
      if (locales && Array.isArray(locales) && locales.length > 0) {
        // Verificar que todos los locales especificados pertenezcan al admin
        const tienePermiso = locales.every(localId => 
          req.user.locales && req.user.locales.some(adminLocal => 
            adminLocal.toString() === localId
          )
        );
        
        if (!tienePermiso) {
          return res.status(403).json({
            success: false,
            message: 'Solo puede asignar usuarios a sus propios locales/marcas'
          });
        }
      } else {
        // Si no se especifican locales, asignar los locales del admin
        req.body.locales = req.user.locales;
      }
    } else if (req.userRole === 'superAdmin') {
      // Verificar que los locales existan
      if (locales && Array.isArray(locales) && locales.length > 0) {
        for (const localId of locales) {
          const localExiste = await Local.findById(localId);
          if (!localExiste) {
            return res.status(404).json({
              success: false,
              message: `El local/marca con ID ${localId} no existe`
            });
          }
        }
      }
    }
    
    // Verificar si el usuario ya existe
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'El email ya está registrado' 
      });
    }
    
    // Preparar datos del usuario
    const userData = {
      nombre,
      email,
      password,
      role: role || 'usuario',
      telefono,
      direccion,
      organizacion,
      verificado: true, // El usuario creado por admin ya está verificado
      creadoPor: req.userId, // Registrar quién creó el usuario
      enLinea: false, // Nuevo usuario no está en línea
      activo: true, // Nuevo usuario está activo
      ultimaModificacion: {
        usuario: req.userId,
        fecha: Date.now()
      }
    };
    
    // Asignar locales si están presentes
    if (locales && Array.isArray(locales) && locales.length > 0) {
      userData.locales = locales;
      // Si hay locales, establecer el primero como localPrincipal
      userData.localPrincipal = locales[0];
    }
    
    // Crear el usuario
    const newUser = await User.create(userData);
    
    // Si se creó un admin con locales asignados, marcarlo como administrador del local
    if (newUser.role === 'admin' && newUser.locales && newUser.locales.length > 0) {
      newUser.esAdministradorLocal = true;
      await newUser.save();
    }
    
    // Omitir la contraseña en la respuesta
    const userResponse = {
      id: newUser._id,
      nombre: newUser.nombre,
      email: newUser.email,
      role: newUser.role,
      locales: newUser.locales,
      localPrincipal: newUser.localPrincipal,
      telefono: newUser.telefono,
      direccion: newUser.direccion,
      organizacion: newUser.organizacion,
      enLinea: newUser.enLinea,
      activo: newUser.activo
    };
    
    res.status(201).json({
      success: true,
      message: 'Usuario creado exitosamente',
      data: userResponse
    });
  } catch (error) {
    logger.error(`Error creando usuario: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al crear usuario',
      error: error.message 
    });
  }
};

// Actualizar un usuario
export const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const updateData = req.body;
    
    // Verificar límite de superAdmins si se está cambiando el rol a superAdmin
    if (updateData.role === 'superAdmin') {
      const user = await User.findById(userId);
      if (user.role !== 'superAdmin') { // Solo si no era ya superAdmin
        const superAdminsCount = await User.countDocuments({ role: 'superAdmin' });
        if (superAdminsCount >= MAX_SUPER_ADMINS) {
          return res.status(400).json({
            success: false,
            message: `No se pueden tener más de ${MAX_SUPER_ADMINS} superAdmins en el sistema`
          });
        }
      }
    }
    
    // Buscar el usuario a actualizar
    const user = await User.findById(userId).populate('locales', 'nombre');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    // Si es admin, solo puede actualizar usuarios de sus locales
    if (req.userRole === 'admin') {
      // Verificar si el usuario pertenece a alguno de los locales que administra
      const puedeAdministrar = req.user.puedeAdministrar(user);
      
      if (!puedeAdministrar) {
        return res.status(403).json({
          success: false,
          message: 'No puede editar usuarios de otros locales/marcas'
        });
      }
      
      // No puede cambiar el rol ni el local
      delete updateData.role;
      delete updateData.locales;
      delete updateData.localPrincipal;
    } else if (req.userRole === 'superAdmin') {
      // Si es superAdmin y cambia a un usuario a admin, verificar que tenga local asignado
      if (updateData.role === 'admin' && 
          (!updateData.locales || !updateData.locales.length) && 
          !user.locales.length) {
        return res.status(400).json({
          success: false,
          message: 'Debe asignar al menos un local al administrador'
        });
      }
      
      // Si se están cambiando los locales, verificar que existan
      if (updateData.locales && Array.isArray(updateData.locales)) {
        for (const localId of updateData.locales) {
          const localExiste = await Local.findById(localId);
          if (!localExiste) {
            return res.status(404).json({
              success: false,
              message: `El local/marca con ID ${localId} no existe`
            });
          }
        }
      }
    }
    
    // No permitir cambiar el rol a superAdmin a menos que sea superAdmin
    if (updateData.role === 'superAdmin' && req.userRole !== 'superAdmin') {
      return res.status(403).json({
        success: false,
        message: 'No tiene permisos para asignar el rol de superAdmin'
      });
    }
    
    // No permitir cambiar el rol de un superAdmin si no eres superAdmin
    if (user.role === 'superAdmin' && req.userRole !== 'superAdmin') {
      return res.status(403).json({
        success: false,
        message: 'No tiene permisos para modificar un superAdmin'
      });
    }
    
    // Eliminar campos que no deben actualizarse directamente
    delete updateData.password;
    delete updateData.intentosFallidos;
    delete updateData.bloqueadoHasta;
    delete updateData.passwordResetToken;
    delete updateData.passwordResetExpires;
    
    // Registrar quién modificó el usuario
    updateData.ultimaModificacion = {
      usuario: req.userId,
      fecha: Date.now()
    };
    
    // Si cambia a admin y tiene locales, marcar como administrador del local
    if (updateData.role === 'admin' && 
        ((updateData.locales && updateData.locales.length > 0) || user.locales.length > 0)) {
      updateData.esAdministradorLocal = true;
    }
    
    // Si se están actualizando los locales, actualizar también el localPrincipal
    if (updateData.locales && Array.isArray(updateData.locales) && updateData.locales.length > 0) {
      updateData.localPrincipal = updateData.locales[0];
    }
    
    // Actualizar el usuario
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select('-password')
     .populate('locales', 'nombre direccion')
     .populate('localPrincipal', 'nombre direccion');
    
    res.status(200).json({
      success: true,
      message: 'Usuario actualizado exitosamente',
      data: updatedUser
    });
  } catch (error) {
    logger.error(`Error actualizando usuario: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al actualizar usuario',
      error: error.message 
    });
  }
};

// Eliminar un usuario (solo superAdmin)
export const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Solo permitir a superAdmin eliminar usuarios
    if (req.userRole !== 'superAdmin') {
      return res.status(403).json({
        success: false,
        message: 'Solo superAdmin puede eliminar usuarios'
      });
    }
    
    // Buscar el usuario
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    // Prevenir eliminación de superAdmin si quedaría menos de uno activo
    if (user.role === 'superAdmin') {
      const superAdminsCount = await User.countDocuments({ role: 'superAdmin', activo: true });
      if (superAdminsCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'No se puede eliminar el último superAdmin activo del sistema'
        });
      }
    }
    
    // Prevenir eliminación del último admin de un local
    if (user.role === 'admin' && user.local) {
      const adminsCount = await User.countDocuments({ 
        role: 'admin', 
        local: user.local, 
        activo: true 
      });
      
      if (adminsCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'No se puede eliminar el único administrador de este local/marca'
        });
      }
    }
    
    // En lugar de eliminar, marcar como inactivo para mantener historial
    await User.findByIdAndUpdate(userId, { 
      activo: false,
      enLinea: false, // Si se desactiva, también está desconectado
      ultimaModificacion: {
        usuario: req.userId,
        fecha: Date.now()
      }
    });
    
    res.status(200).json({
      success: true,
      message: 'Usuario eliminado exitosamente'
    });
  } catch (error) {
    logger.error(`Error eliminando usuario: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar usuario',
      error: error.message 
    });
  }
};

// Restablecer contraseña de un usuario (admin o superAdmin)
export const resetUserPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;
    
    // Buscar el usuario
    const user = await User.findById(userId).populate('locales', 'nombre');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    // Verificar permisos: admin solo puede restablecer contraseñas de usuarios de sus locales
    if (req.userRole === 'admin') {
      if (user.role === 'superAdmin' || user.role === 'admin') {
        return res.status(403).json({
          success: false,
          message: 'No tiene permisos para cambiar la contraseña de este usuario'
        });
      }
      
      // Verificar si el usuario pertenece a alguno de los locales del admin
      const tienePermisos = user.locales && user.locales.some(local => 
        req.user.locales && req.user.locales.some(adminLocal => 
          adminLocal.toString() === local._id.toString()
        )
      );
      
      if (!tienePermisos) {
        return res.status(403).json({
          success: false,
          message: 'No tiene permisos para cambiar la contraseña de usuarios de otro local/marca'
        });
      }
    }
    
    // Actualizar la contraseña
    user.password = newPassword;
    user.intentosFallidos = 0;
    user.bloqueadoHasta = undefined;
    user.ultimaModificacion = {
      usuario: req.userId,
      fecha: Date.now()
    };
    
    await user.save();
    
    res.status(200).json({
      success: true,
      message: 'Contraseña restablecida exitosamente'
    });
  } catch (error) {
    logger.error(`Error restableciendo contraseña: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al restablecer la contraseña',
      error: error.message 
    });
  }
};

// Activar/Desactivar un usuario
export const toggleUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { activo } = req.body;
    
    // Modificar la consulta para incluir usuarios inactivos
    const user = await User.findOne({ _id: userId, includeInactive: true })
      .populate('locales', 'nombre direccion');
    
    if (!user) {
      logger.warn(`Usuario no encontrado: ${userId}`);
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    // Verificar permisos: admin solo puede cambiar estado de usuarios de sus locales
    if (req.userRole === 'admin') {
      if (user.role === 'superAdmin' || user.role === 'admin') {
        return res.status(403).json({
          success: false,
          message: 'No tiene permisos para cambiar el estado de este usuario'
        });
      }
      
      // Verificar si el usuario pertenece a alguno de los locales del admin
      const tienePermisos = user.locales && user.locales.some(local => 
        req.user.locales && req.user.locales.some(adminLocal => 
          adminLocal.toString() === local._id.toString()
        )
      );
      
      if (!tienePermisos) {
        return res.status(403).json({
          success: false,
          message: 'No tiene permisos para cambiar el estado de usuarios de otro local/marca'
        });
      }
    }
    
    // Prevenir desactivación del último superAdmin activo
    if (user.role === 'superAdmin' && !activo) {
      const superAdminsCount = await User.countDocuments({ role: 'superAdmin', activo: true });
      if (superAdminsCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'No se puede desactivar el último superAdmin activo del sistema'
        });
      }
    }
    
    // Prevenir desactivación del último admin de un local
    if (user.role === 'admin' && user.locales && user.locales.length > 0 && !activo) {
      // Verificar cada local del admin
      for (const local of user.locales) {
        const adminsCount = await User.countDocuments({ 
          role: 'admin', 
          locales: local._id, 
          activo: true 
        });
        
        if (adminsCount <= 1) {
          return res.status(400).json({
            success: false,
            message: `No se puede desactivar el único administrador del local/marca ${local.nombre}`
          });
        }
      }
    }
    
    // Actualizar el estado
    user.activo = activo;
    
    // Si se desactiva, también poner offline
    if (!activo) {
      user.enLinea = false;
    }
    
    user.ultimaModificacion = {
      usuario: req.userId,
      fecha: Date.now()
    };
    
    await user.save();
    
    // Agregar logging para depuración
    logger.info(`Usuario ${userId} ${activo ? 'activado' : 'desactivado'} exitosamente por ${req.userId}`);
    
    res.status(200).json({
      success: true,
      message: `Usuario ${activo ? 'activado' : 'desactivado'} exitosamente`
    });
  } catch (error) {
    logger.error(`Error cambiando estado de usuario: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al cambiar el estado del usuario',
      error: error.message 
    });
  }
};

// Inicializar superAdmin si no existe ninguno
export const initSuperAdmin = async (req, res) => {
  try {
    const { nombre, email, password } = req.body;
    
    // Verificar si estamos dentro del límite de superAdmins
    const superAdminCount = await User.countDocuments({ role: 'superAdmin' });
    
    if (superAdminCount >= MAX_SUPER_ADMINS) {
      return res.status(400).json({
        success: false,
        message: `No se pueden crear más de ${MAX_SUPER_ADMINS} superAdmins en el sistema`
      });
    }
    
    // Si es el primer superAdmin, usar el método especial, sino crear normalmente
    if (superAdminCount === 0) {
      // Crear el superAdmin inicial
      await User.crearSuperAdminInicial({
        nombre,
        email,
        password
      });
    } else {
      // Crear superAdmin adicional
      await User.create({
        nombre,
        email,
        password,
        role: 'superAdmin',
        verificado: true,
        activo: true
      });
    }
    
    res.status(201).json({
      success: true,
      message: 'SuperAdmin creado exitosamente'
    });
  } catch (error) {
    logger.error(`Error inicializando superAdmin: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Error al inicializar superAdmin',
      error: error.message 
    });
  }
};

// Obtener estadísticas generales de todos los administradores
export const getAdminStats = async (req, res) => {
  try {
    // Obtener todos los administradores con sus locales
    const admins = await User.find({ role: 'admin', activo: true })
      .populate('locales', 'nombre direccion')
      .populate('localPrincipal', 'nombre direccion')
      .select('-password');
    
    // Preparar respuesta con estadísticas
    const adminStats = await Promise.all(admins.map(async (admin) => {
      // Contar usuarios por cada local del administrador
      const localesStats = await Promise.all(admin.locales.map(async (local) => {
        const usuariosCount = await User.countDocuments({ 
          role: 'usuario', 
          locales: local._id
        });
        
        return {
          id: local._id,
          nombre: local.nombre,
          direccion: local.direccion,
          usuariosCount
        };
      }));
      
      // Total de usuarios administrados
      const totalUsuarios = localesStats.reduce((sum, local) => sum + local.usuariosCount, 0);
      
      return {
        id: admin._id,
        nombre: admin.nombre,
        email: admin.email,
        totalLocales: admin.locales.length,
        totalUsuarios,
        localPrincipal: admin.localPrincipal ? {
          id: admin.localPrincipal._id,
          nombre: admin.localPrincipal.nombre
        } : null,
        ultimoAcceso: admin.ultimoAcceso
      };
    }));
    
    res.status(200).json({
      success: true,
      message: 'Estadísticas de administradores obtenidas exitosamente',
      data: {
        totalAdmins: adminStats.length,
        admins: adminStats
      }
    });
  } catch (error) {
    logger.error(`Error obteniendo estadísticas de administradores: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas de administradores',
      error: error.message
    });
  }
};

// Obtener estadísticas detalladas de un administrador específico
export const getAdminDetailStats = async (req, res) => {
  try {
    const { adminId } = req.params;
    
    // Verificar permisos
    if (req.userRole === 'admin' && req.userId !== adminId) {
      return res.status(403).json({
        success: false,
        message: 'No tiene permisos para ver estadísticas de otro administrador'
      });
    }
    
    // Obtener el administrador con sus locales
    const admin = await User.findOne({ 
      _id: adminId, 
      role: 'admin' 
    })
    .populate('locales', 'nombre direccion activo')
    .populate('localPrincipal', 'nombre direccion')
    .populate('creadoPor', 'nombre email')
    .populate('ultimaModificacion.usuario', 'nombre email')
    .select('-password');
    
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Administrador no encontrado'
      });
    }
    
    // Obtener estadísticas detalladas por cada local
    const localesStats = await Promise.all(admin.locales.map(async (local) => {
      // Contar usuarios por rol en este local
      const usuariosCount = await User.countDocuments({ 
        role: 'usuario', 
        locales: local._id 
      });
      
      // Obtener últimos usuarios registrados en este local
      const ultimosUsuarios = await User.find({ 
        role: 'usuario', 
        locales: local._id 
      })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('nombre email createdAt ultimoAcceso');
      
      // Usuarios activos en últimos 30 días
      const treintaDiasAtras = new Date();
      treintaDiasAtras.setDate(treintaDiasAtras.getDate() - 30);
      
      const usuariosActivos = await User.countDocuments({
        role: 'usuario',
        locales: local._id,
        ultimoAcceso: { $gte: treintaDiasAtras }
      });
      
      return {
        id: local._id,
        nombre: local.nombre,
        direccion: local.direccion,
        activo: local.activo,
        estadisticas: {
          totalUsuarios: usuariosCount,
          usuariosActivos,
          porcentajeActivos: usuariosCount > 0 ? Math.round((usuariosActivos / usuariosCount) * 100) : 0
        },
        ultimosUsuarios
      };
    }));
    
    // Total de usuarios administrados
    const totalUsuarios = localesStats.reduce((sum, local) => sum + local.estadisticas.totalUsuarios, 0);
    
    // Crear objeto de respuesta
    const adminStats = {
      id: admin._id,
      nombre: admin.nombre,
      email: admin.email,
      telefono: admin.telefono,
      activo: admin.activo,
      enLinea: admin.enLinea,
      ultimoAcceso: admin.ultimoAcceso,
      createdAt: admin.createdAt,
      creadoPor: admin.creadoPor,
      ultimaModificacion: admin.ultimaModificacion,
      estadisticas: {
        totalLocales: admin.locales.length,
        totalUsuarios,
        localPrincipal: admin.localPrincipal ? {
          id: admin.localPrincipal._id,
          nombre: admin.localPrincipal.nombre
        } : null
      },
      locales: localesStats
    };
    
    res.status(200).json({
      success: true,
      message: 'Estadísticas detalladas del administrador obtenidas exitosamente',
      data: adminStats
    });
  } catch (error) {
    logger.error(`Error obteniendo estadísticas detalladas: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas detalladas del administrador',
      error: error.message
    });
  }
};

/**
 * Asigna un local adicional a un administrador
 * @param {Object} req - Objeto de solicitud
 * @param {Object} res - Objeto de respuesta
 */
export const assignLocalToAdmin = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { localId } = req.body;

    if (!localId) {
      return res.status(400).json({ success: false, message: 'ID del local es requerido' });
    }

    // Verificar que el administrador existe
    const admin = await User.findOne({ _id: adminId, role: 'admin' });
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Administrador no encontrado' });
    }

    // Verificar que el local existe
    const local = await Local.findById(localId);
    if (!local) {
      return res.status(404).json({ success: false, message: 'Local no encontrado' });
    }

    // Verificar si ya tiene asignado este local
    if (admin.locales.includes(localId)) {
      return res.status(400).json({ success: false, message: 'El local ya está asignado a este administrador' });
    }

    // Agregar el local a la lista de locales del administrador
    admin.locales.push(localId);
    
    // Si es el primer local, establecerlo como principal
    if (admin.locales.length === 1) {
      admin.localPrincipal = localId;
    }

    await admin.save();

    logger.info(`Local ${localId} asignado correctamente al administrador ${adminId}`);
    return res.status(200).json({ 
      success: true, 
      message: 'Local asignado correctamente', 
      data: {
        adminId: admin._id,
        locales: admin.locales,
        localPrincipal: admin.localPrincipal
      }
    });
  } catch (error) {
    logger.error(`Error al asignar local al administrador: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: 'Error al asignar local al administrador', error: error.message });
  }
};

/**
 * Elimina un local asignado a un administrador
 * @param {Object} req - Objeto de solicitud
 * @param {Object} res - Objeto de respuesta
 */
export const removeLocalFromAdmin = async (req, res) => {
  try {
    const { adminId, localId } = req.params;

    // Verificar que el administrador existe
    const admin = await User.findOne({ _id: adminId, role: 'admin' });
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Administrador no encontrado' });
    }

    // Verificar si el local está asignado
    if (!admin.locales.includes(localId)) {
      return res.status(400).json({ success: false, message: 'El local no está asignado a este administrador' });
    }

    // No permitir eliminar el único local asignado
    if (admin.locales.length === 1) {
      return res.status(400).json({ 
        success: false, 
        message: 'No se puede eliminar el único local asignado. El administrador debe tener al menos un local asignado'
      });
    }

    // Eliminar el local de la lista
    admin.locales = admin.locales.filter(id => id.toString() !== localId);
    
    // Si el local eliminado era el principal, asignar otro como principal
    if (admin.localPrincipal && admin.localPrincipal.toString() === localId) {
      admin.localPrincipal = admin.locales[0];
    }

    await admin.save();

    logger.info(`Local ${localId} eliminado correctamente del administrador ${adminId}`);
    return res.status(200).json({ 
      success: true, 
      message: 'Local eliminado correctamente', 
      data: {
        adminId: admin._id,
        locales: admin.locales,
        localPrincipal: admin.localPrincipal
      }
    });
  } catch (error) {
    logger.error(`Error al eliminar local del administrador: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: 'Error al eliminar local del administrador', error: error.message });
  }
};

/**
 * Establece un local como principal para un administrador
 * @param {Object} req - Objeto de solicitud
 * @param {Object} res - Objeto de respuesta
 */
export const setAdminPrimaryLocal = async (req, res) => {
  try {
    const { adminId, localId } = req.params;

    // Verificar que el administrador existe
    const admin = await User.findOne({ _id: adminId, role: 'admin' });
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Administrador no encontrado' });
    }

    // Verificar si el local está asignado
    if (!admin.locales.includes(localId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'No se puede establecer como principal un local que no está asignado al administrador'
      });
    }

    // Establecer local como principal
    admin.localPrincipal = localId;
    await admin.save();

    logger.info(`Local ${localId} establecido como principal para el administrador ${adminId}`);
    return res.status(200).json({ 
      success: true, 
      message: 'Local principal establecido correctamente', 
      data: {
        adminId: admin._id,
        locales: admin.locales,
        localPrincipal: admin.localPrincipal
      }
    });
  } catch (error) {
    logger.error(`Error al establecer local principal: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: 'Error al establecer local principal', error: error.message });
  }
}; 