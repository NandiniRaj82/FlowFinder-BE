const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const UserSchema = new mongoose.Schema({
    fullName:{
        type: String,
        required: true
    },
    email:{
        type: String,
        required: true,
        unique: true
    },
    password:{
        type: String,
        required: true
    }
});
async function SaveUser(user){
    try{
        const salt = await bcrypt.genSalt(10);
        const hasspass = await bcrypt.hash(user.password,salt);
        user.password = hasspass;
    
    } catch (error) {
        throw error;
    }
}
UserSchema.pre("save", async function(next){
    await SaveUser(this);
}
);
UserSchema.methods.comparePassword = async function(password){
    try{
        const isMatch = await bcrypt.compare(password,this.password);
        return isMatch;
    } catch (error) {
        throw error;
    }   
};

const User = mongoose.model("User",UserSchema);
module.exports = User;